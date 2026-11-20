import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, RenderElement } from 'claude-code'

import type { Project, Status, TestCase, Tool } from '../types'
import {
  merge,
  parseCargoList,
  parseCargoRun,
  parseDotnetList,
  parseDotnetRun,
  parseGoList,
  parseGoRun,
  parseJunitXml,
  parseMochaList,
  parseMochaRun,
  parsePlaywrightList,
  parsePlaywrightRun,
  parsePluginTestRun,
  parsePluginTestSource,
  parsePytestList,
  parsePytestRun,
  parseRspecList,
  parseRspecRun,
  parseVitestList,
  parseVitestRun,
  TOOL_LABEL,
  type Outcome,
} from './adapters'

const PANE = 'test-explorer'
const TITLE = 'Tests'
const MAX_DEPTH = 6
const MAX_DIRS = 3000
const MAX_ROWS = 400
const LIST_TIMEOUT = 180_000
const RUN_TIMEOUT = 600_000
const ENV = { NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' }
const SKIP = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'target', 'out', 'coverage', '__pycache__', 'venv'])
const TOOLS: Tool[] = [
  'dotnet',
  'pytest',
  'vitest',
  'jest',
  'mocha',
  'playwright',
  'go',
  'cargo',
  'maven',
  'gradle',
  'rspec',
  'claude-plugin',
]
const REPORT_DIRS: Partial<Record<Tool, string>> = { maven: 'target/surefire-reports', gradle: 'build/test-results/test' }
const ICON: Record<Status, string> = { passed: '✓', failed: '✗', skipped: '–', unknown: '·' }
const COLOR: Record<Status, string | undefined> = {
  passed: 'success',
  failed: 'error',
  skipped: 'warning',
  unknown: undefined,
}

const projects = atom({ plugin: 'test-explorer', key: 'projects' } as const, [], { shape: 'projects-1' })
const isScanning = atom({ plugin: 'test-explorer', key: 'isScanning' } as const, false)
const filter = atom({ plugin: 'test-explorer', key: 'filter' } as const, '')
const isFailedOnly = atom({ plugin: 'test-explorer', key: 'isFailedOnly' } as const, false)

type Adapter = {
  list: (p: Project) => Promise<TestCase[]>
  run: (p: Project) => Promise<{ outcomes: Outcome[]; output: string; exitCode: number }>
}

const slash = (path: string) => path.replace(/\\/g, '/')
const join = (dir: string, name: string) => `${dir}/${name}`
const tail = (text: string, count = 30) => text.trim().split(/\r?\n/).slice(-count).join('\n')

const readText = async ($: EngineInterface, path: string) => {
  try {
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

const exec = async ($: EngineInterface, argv: readonly string[], cwd: string, timeoutMs: number) => {
  const r = await $.process.run(argv, { cwd, env: ENV, timeoutMs })

  return { output: `${r.stdout}\n${r.stderr}`, stdout: r.stdout, exitCode: r.exitCode }
}

const pytestArgv = async ($: EngineInterface, dir: string) => {
  for (const python of ['.venv/Scripts/python.exe', '.venv/bin/python'])
    if (await $.fs.exists(join(dir, python))) return [join(dir, python), '-m', 'pytest']
  if (await $.fs.exists(join(dir, 'uv.lock'))) return ['uv', 'run', 'pytest']

  return ['python', '-m', 'pytest']
}

const nodeEntry = async ($: EngineInterface, dir: string, root: string, file: string, label: string) => {
  for (let at = dir; at.length >= root.length; at = at.slice(0, Math.max(0, at.lastIndexOf('/')))) {
    const entry = join(at, `node_modules/${file}`)
    if (await $.fs.exists(entry)) return entry
    if (!at.includes('/')) break
  }
  throw new Error(`${label} is not installed here: run npm install first.`)
}

// Batch and cmd launchers (mvn, gradle, bundle, rspec and the wrappers) only start through cmd on Windows.
const isWindows = async ($: EngineInterface) => (await $.env.get('OS')) === 'Windows_NT'

const launcher = async ($: EngineInterface, dir: string, wrapper: string, tool: string) => {
  const windows = await isWindows($)
  const script = windows ? `${wrapper}.${wrapper === 'gradlew' ? 'bat' : 'cmd'}` : wrapper
  const command = (await $.fs.exists(join(dir, script))) ? join(dir, script) : tool

  return windows ? ['cmd', '/c', command] : [command]
}

const rspecArgv = async ($: EngineInterface, dir: string) => {
  const base = (await $.fs.exists(join(dir, 'Gemfile'))) ? ['bundle', 'exec', 'rspec'] : ['rspec']

  return (await isWindows($)) ? ['cmd', '/c', ...base] : base
}

const junitReports = async ($: EngineInterface, project: Project) => {
  const dir = join(project.dir, REPORT_DIRS[project.tool] ?? '')
  let files: readonly FsEntry[]
  try {
    files = await $.fs.list(dir)
  } catch {
    return []
  }
  const found = await Promise.all(
    files.filter(f => /^TEST-.*\.xml$/.test(f.name)).map(async f => parseJunitXml(await readText($, join(dir, f.name)))),
  )

  return found.flat()
}

const junit = ($: EngineInterface, argv: (p: Project) => Promise<string[]>): Adapter => ({
  // Neither Maven nor Gradle lists tests without running them: the reports of the last run stand in.
  list: async p => (await junitReports($, p)).map(o => ({ name: o.name, group: o.group ?? '', status: 'unknown' })),
  run: async p => {
    const r = await exec($, await argv(p), p.dir, RUN_TIMEOUT)

    return { ...r, outcomes: await junitReports($, p) }
  },
})

const adapters = ($: EngineInterface, root: string): Record<Tool, Adapter> => ({
  dotnet: {
    list: async p =>
      parseDotnetList((await exec($, ['dotnet', 'test', p.file!, '--list-tests', '--nologo'], p.dir, LIST_TIMEOUT)).output),
    run: async p => {
      const r = await exec(
        $,
        ['dotnet', 'test', p.file!, '--nologo', '--logger', 'console;verbosity=normal'],
        p.dir,
        RUN_TIMEOUT,
      )

      return { ...r, outcomes: parseDotnetRun(r.output) }
    },
  },
  pytest: {
    list: async p =>
      parsePytestList((await exec($, [...(await pytestArgv($, p.dir)), '--collect-only', '-q'], p.dir, LIST_TIMEOUT)).stdout),
    run: async p => {
      const r = await exec($, [...(await pytestArgv($, p.dir)), '-q', '-rA', '--color=no'], p.dir, RUN_TIMEOUT)

      return { ...r, outcomes: parsePytestRun(r.stdout) }
    },
  },
  vitest: {
    list: async p => {
      const entry = await nodeEntry($, p.dir, root, 'vitest/vitest.mjs', 'Vitest')

      return parseVitestList((await exec($, ['node', entry, 'list', '--json'], p.dir, LIST_TIMEOUT)).stdout, p.dir)
    },
    run: async p => {
      const entry = await nodeEntry($, p.dir, root, 'vitest/vitest.mjs', 'Vitest')
      const r = await exec($, ['node', entry, 'run', '--reporter=json'], p.dir, RUN_TIMEOUT)

      return { ...r, outcomes: parseVitestRun(r.stdout, p.dir) }
    },
  },
  jest: {
    // Jest lists files, not tests: the tests appear with the first run.
    list: async () => [],
    run: async p => {
      const entry = await nodeEntry($, p.dir, root, 'jest/bin/jest.js', 'Jest')
      const r = await exec($, ['node', entry, '--json', '--ci'], p.dir, RUN_TIMEOUT)

      return { ...r, outcomes: parseVitestRun(r.stdout, p.dir) }
    },
  },
  mocha: {
    list: async p => {
      const entry = await nodeEntry($, p.dir, root, 'mocha/bin/mocha.js', 'Mocha')

      return parseMochaList((await exec($, ['node', entry, '--dry-run', '--reporter', 'json'], p.dir, LIST_TIMEOUT)).stdout, p.dir)
    },
    run: async p => {
      const entry = await nodeEntry($, p.dir, root, 'mocha/bin/mocha.js', 'Mocha')
      const r = await exec($, ['node', entry, '--reporter', 'json'], p.dir, RUN_TIMEOUT)

      return { ...r, outcomes: parseMochaRun(r.stdout, p.dir) }
    },
  },
  playwright: {
    list: async p => {
      const entry = await nodeEntry($, p.dir, root, '@playwright/test/cli.js', 'Playwright')
      const r = await exec($, ['node', entry, 'test', '--list', '--reporter=json'], p.dir, LIST_TIMEOUT)

      return parsePlaywrightList(r.stdout, p.dir)
    },
    run: async p => {
      const entry = await nodeEntry($, p.dir, root, '@playwright/test/cli.js', 'Playwright')
      const r = await exec($, ['node', entry, 'test', '--reporter=json'], p.dir, RUN_TIMEOUT)

      return { ...r, outcomes: parsePlaywrightRun(r.stdout, p.dir) }
    },
  },
  go: {
    list: async p => parseGoList((await exec($, ['go', 'test', '-list', '.', './...'], p.dir, LIST_TIMEOUT)).stdout),
    run: async p => {
      const r = await exec($, ['go', 'test', '-json', './...'], p.dir, RUN_TIMEOUT)

      return { ...r, outcomes: parseGoRun(r.stdout) }
    },
  },
  cargo: {
    list: async p =>
      parseCargoList((await exec($, ['cargo', 'test', '--', '--list', '--format', 'terse'], p.dir, LIST_TIMEOUT)).stdout),
    run: async p => {
      const r = await exec($, ['cargo', 'test', '--no-fail-fast'], p.dir, RUN_TIMEOUT)

      return { ...r, outcomes: parseCargoRun(r.stdout) }
    },
  },
  maven: junit($, async p => [...(await launcher($, p.dir, 'mvnw', 'mvn')), '-B', 'test', '-Dmaven.test.failure.ignore=true']),
  gradle: junit($, async p => [...(await launcher($, p.dir, 'gradlew', 'gradle')), 'test', '--continue']),
  rspec: {
    list: async p =>
      parseRspecList((await exec($, [...(await rspecArgv($, p.dir)), '--dry-run', '--format', 'json'], p.dir, LIST_TIMEOUT)).stdout),
    run: async p => {
      const r = await exec($, [...(await rspecArgv($, p.dir)), '--format', 'json'], p.dir, RUN_TIMEOUT)

      return { ...r, outcomes: parseRspecRun(r.stdout) }
    },
  },
  'claude-plugin': {
    list: async p => {
      const files = (await $.fs.list(join(p.dir, 'tests'))).filter(f => /\.test\.[cm]?[jt]sx?$/.test(f.name))
      const found = await Promise.all(
        files.map(async f => parsePluginTestSource(await readText($, join(p.dir, `tests/${f.name}`)), f.name)),
      )

      return found.flat()
    },
    run: async p => {
      const r = await exec($, ['claude', 'plugin', 'test', p.dir], p.dir, RUN_TIMEOUT)

      return { ...r, outcomes: parsePluginTestRun(r.output) }
    },
  },
})

const detect = async ($: EngineInterface, root: string, dir: string, entries: readonly FsEntry[]) => {
  const names = new Set(entries.map(e => e.name))
  const has = async (name: string, pattern: RegExp) => names.has(name) && pattern.test(await readText($, join(dir, name)))
  const rel = dir === root ? '.' : dir.slice(root.length + 1)
  const base = (dir === root ? root : rel).split('/').pop() ?? rel
  const make = (tool: Tool, name: string, file?: string): Project => ({
    id: `${tool}:${file ? `${rel}/${file}` : rel}`,
    name,
    dir,
    file,
    tool,
    tests: [],
    state: 'idle',
    isOpen: false,
  })
  const found: Project[] = []

  for (const csproj of entries.filter(e => e.kind === 'file' && e.name.endsWith('.csproj')))
    if (await has(csproj.name, /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true|xunit|nunit|mstest/i))
      found.push(make('dotnet', csproj.name.replace(/\.csproj$/, ''), csproj.name))
  if (
    names.has('pytest.ini') ||
    (await has('pyproject.toml', /\[tool\.pytest/)) ||
    (await has('setup.cfg', /\[tool:pytest\]/)) ||
    (await has('tox.ini', /^\[pytest\]/m))
  )
    found.push(make('pytest', base))
  if (await has('package.json', /"vitest"\s*:/)) found.push(make('vitest', base))
  if (await has('package.json', /"jest"\s*:/)) found.push(make('jest', base))
  if (await has('package.json', /"mocha"\s*:/)) found.push(make('mocha', base))
  if (await has('package.json', /"@playwright\/test"\s*:/)) found.push(make('playwright', base))
  if (names.has('go.mod')) found.push(make('go', base))
  if (names.has('Cargo.toml')) found.push(make('cargo', base))
  if (names.has('pom.xml')) found.push(make('maven', base))
  if (names.has('build.gradle') || names.has('build.gradle.kts')) found.push(make('gradle', base))
  if (names.has('.rspec') || (await has('Gemfile', /rspec/))) found.push(make('rspec', base))
  if (names.has('.claude-plugin') && names.has('tests')) found.push(make('claude-plugin', base))

  return found
}

const scanFolders = async ($: EngineInterface, root: string) => {
  const found: Project[] = []
  const queue = [{ dir: root, depth: 0 }]
  for (let seen = 0; queue.length > 0 && seen < MAX_DIRS; seen++) {
    const { dir, depth } = queue.shift()!
    let entries: readonly FsEntry[]
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    found.push(...(await detect($, root, dir, entries)))
    if (depth < MAX_DEPTH)
      for (const e of entries)
        if (e.kind === 'dir' && !e.name.startsWith('.') && !SKIP.has(e.name))
          queue.push({ dir: join(dir, e.name), depth: depth + 1 })
  }

  return found
}

const patch = ($: EngineInterface, id: string, change: (p: Project) => Project) =>
  update($, projects, list => list.map(p => (p.id === id ? change(p) : p)))

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error))

const discover = async ($: EngineInterface, root: string, project: Project) => {
  await patch($, project.id, p => ({ ...p, state: 'discovering', error: undefined }))
  try {
    const tests = await adapters($, root)[project.tool].list(project)
    await patch($, project.id, p => ({ ...p, state: 'idle', tests: merge(tests, []) }))
  } catch (error) {
    await patch($, project.id, p => ({ ...p, state: 'idle', error: failure(error) }))
  }
}

const runProject = async ($: EngineInterface, id: string) => {
  const root = slash(await $.session.cwd())
  const project = (await read($, projects)).find(p => p.id === id)
  if (!project || project.state !== 'idle') return

  await patch($, id, p => ({ ...p, state: 'running', error: undefined }))
  try {
    const r = await adapters($, root)[project.tool].run(project)
    await patch($, id, p => ({
      ...p,
      state: 'idle',
      tests: merge(p.tests, r.outcomes),
      isOpen: p.isOpen || r.outcomes.some(o => o.status === 'failed'),
      error: r.outcomes.length === 0 && r.exitCode !== 0 ? tail(r.output) : undefined,
    }))
  } catch (error) {
    await patch($, id, p => ({ ...p, state: 'idle', error: failure(error) }))
  }
}

const scan = async ($: EngineInterface) => {
  if (await read($, isScanning)) return
  await update($, isScanning, () => true)
  try {
    const root = slash(await $.session.cwd())
    const known = new Map((await read($, projects)).map(p => [p.id, p]))
    const found = (await scanFolders($, root)).map(p => {
      const old = known.get(p.id)

      return old ? { ...p, tests: old.tests, isOpen: old.isOpen } : p
    })
    await update($, projects, () => found)
    for (const project of found) await discover($, root, project)
  } finally {
    await update($, isScanning, () => false)
  }
}

const runAll = async ($: EngineInterface) => {
  for (const project of await read($, projects)) await runProject($, project.id)
}

const askClaude = ($: EngineInterface, project: Project, test: TestCase) =>
  $.prompt.submit({
    text: [
      `The ${TOOL_LABEL[project.tool]} test \`${test.name}\` in \`${project.file ? `${project.dir}/${project.file}` : project.dir}\` fails.`,
      test.message ? `\n\`\`\`\n${test.message}\n\`\`\`\n` : '',
      'Find the cause and fix it, then run this test again to confirm.',
    ].join('\n'),
  })

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE })

const count = (tests: readonly TestCase[], status: Status) => tests.filter(t => t.status === status).length

type Rollup = Status | 'running'

const ROLLUP_ICON: Record<Rollup, string> = { ...ICON, running: '◌' }
const ROLLUP_COLOR: Record<Rollup, string | undefined> = { ...COLOR, running: undefined }
const STATUS_WIDTH = 2
const TIME_WIDTH = 9
const ACTION_WIDTH = 8
const INDENT = 2

const rollup = (tests: readonly TestCase[], state: Project['state']): Rollup => {
  if (state !== 'idle') return 'running'
  if (tests.some(t => t.status === 'failed')) return 'failed'
  if (tests.length > 0 && tests.every(t => t.status !== 'unknown'))
    return tests.some(t => t.status === 'passed') ? 'passed' : 'skipped'

  return 'unknown'
}

const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)

const duration = (tests: readonly TestCase[]) => {
  const timed = tests.filter(t => t.ms !== undefined)

  return timed.length === 0 ? '' : seconds(timed.reduce((sum, t) => sum + (t.ms ?? 0), 0))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'test-explorer', description: 'Open the test explorer pane' })

    return next(e)
  })

  on('command.run', { command: 'test-explorer' }, async $ => {
    await openPane($)
    if ((await read($, projects)).length === 0) void scan($)

    return { text: 'Test explorer opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (e.props.hasSurvey || isOpen) return next(e)

    const { Box, Button } = $.ui.resolve(e)
    const open = async () => {
      await openPane($)
      if ((await read($, projects)).length === 0) await scan($)
    }

    return (
      <Box>
        <Button key="open-tests" label="Tests" onPress={() => void open()} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const tags = $.ui.resolve(e)
    const { Box, Text, Button, Input } = tags
    const list = await read($, projects)
    const scanning = await read($, isScanning)
    const query = (await read($, filter)).toLowerCase()
    const failedOnly = await read($, isFailedOnly)
    const all = list.flatMap(p => p.tests)
    const isBusy = scanning || list.some(p => p.state !== 'idle')
    const visible = (t: TestCase) =>
      (!failedOnly || t.status === 'failed') && (query === '' || `${t.group} ${t.name}`.toLowerCase().includes(query))
    const nameWidth = Math.max(16, e.props.bodyColumns - STATUS_WIDTH - TIME_WIDTH - ACTION_WIDTH - 3)
    let rows = 0

    const row = (
      key: string,
      depth: number,
      status: Rollup,
      name: RenderElement,
      time: string,
      action?: RenderElement,
    ) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        <Box width={STATUS_WIDTH} flexShrink={0}>
          <Text color={ROLLUP_COLOR[status]} dimColor={status === 'unknown' || status === 'running'}>
            {ROLLUP_ICON[status]}
          </Text>
        </Box>
        <Box width={nameWidth} flexShrink={0} paddingLeft={depth * INDENT} flexDirection="row" columnGap={1}>
          {name}
        </Box>
        <Box width={TIME_WIDTH} flexShrink={0} justifyContent="flex-end">
          <Text dimColor>
            {time}
          </Text>
        </Box>
        <Box width={ACTION_WIDTH} flexShrink={0}>
          {action}
        </Box>
      </Box>
    )

    const note = (key: string, depth: number, text: string, color?: string) => (
      <Box key={key} paddingLeft={STATUS_WIDTH + 1 + depth * INDENT}>
        <Text color={color} dimColor={color === undefined}>
          {text}
        </Text>
      </Box>
    )

    const testRows = (project: Project) => {
      const shown = project.tests.filter(visible)
      const groups = [...new Set(shown.map(t => t.group))]

      return groups.flatMap(group => {
        const inGroup = shown.filter(t => t.group === group)
        const depth = group === '' ? 2 : 3
        const header =
          group === ''
            ? []
            : [
                row(
                  `${project.id}|${group}`,
                  2,
                  rollup(inGroup, 'idle'),
                  <Text dimColor wrap="truncate-start">
                    {group}
                  </Text>,
                  duration(inGroup),
                ),
              ]

        return [
          ...header,
          ...inGroup
            .filter(() => rows++ < MAX_ROWS)
            .flatMap(t => [
              row(
                `${project.id}|${group}|${t.name}`,
                depth,
                t.status,
                <Text wrap="truncate-end">
                  {group && t.name.startsWith(`${group}.`) ? t.name.slice(group.length + 1) : t.name}
                </Text>,
                t.ms === undefined ? '' : seconds(t.ms),
                t.status === 'failed' ? (
                  <Button key={`fix|${project.id}|${t.name}`} plain onPress={() => void askClaude($, project, t)}>
                    Fix
                  </Button>
                ) : undefined,
              ),
              ...(t.status === 'failed' && t.message
                ? [note(`${project.id}|${group}|${t.name}|message`, depth + 1, t.message.split('\n').slice(0, 4).join('\n'))]
                : []),
            ]),
        ]
      })
    }

    const projectRows = (p: Project) => [
      row(
        p.id,
        1,
        rollup(p.tests, p.state),
        <Box flexDirection="row" columnGap={1}>
          <Button key={`toggle|${p.id}`} plain onPress={() => void patch($, p.id, q => ({ ...q, isOpen: !q.isOpen }))}>
            {p.isOpen ? '▾' : '▸'} {p.name}
          </Button>
          <Text dimColor wrap="truncate-end">
            {p.state === 'discovering'
              ? 'discovering…'
              : p.state === 'running'
                ? 'running…'
                : [`${p.tests.length} tests`, count(p.tests, 'failed') > 0 ? `${count(p.tests, 'failed')} failed` : '']
                    .filter(Boolean)
                    .join(' · ')}
          </Text>
        </Box>,
        duration(p.tests),
        p.state === 'idle' ? (
          <Button key={`run|${p.id}`} plain onPress={() => void runProject($, p.id)}>
            ▶ Run
          </Button>
        ) : undefined,
      ),
      ...(p.error ? [note(`${p.id}|error`, 2, p.error.split('\n').slice(-6).join('\n'), 'error')] : []),
      ...(p.isOpen || query !== '' || failedOnly ? testRows(p) : []),
    ]

    const passed = count(all, 'passed')
    const failed = count(all, 'failed')
    const skipped = count(all, 'skipped')
    const ran = passed + failed + skipped

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="run-all" variant="primary" onPress={() => void runAll($)}>
            ▶ Run all
          </Button>
          <Button key="scan" variant="secondary" onPress={() => void scan($)}>
            {scanning ? 'Scanning…' : '⟳ Refresh'}
          </Button>
          <Button key="failed-only" variant={failedOnly ? 'primary' : 'secondary'} onPress={() => void update($, isFailedOnly, v => !v)}>
            {failedOnly ? 'Show all' : '✗ Failed only'}
          </Button>
        </Box>
        <Input
          key="filter"
          placeholder="Filter tests by name"
          value={query}
          submitLabel="filter"
          onInput={value => void update($, filter, () => value)}
          onSubmit={value => void update($, filter, () => value)}
        />
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Text color="success">{passed} passed</Text>
            <Text color={failed > 0 ? 'error' : undefined} dimColor={failed === 0}>
              {failed} failed
            </Text>
            <Text dimColor>
              {skipped} skipped · {all.length - ran} not run · {list.length} projects
              {isBusy ? ' · working…' : ''}
            </Text>
          </Box>
          {ran > 0 && 'Progress' in tags && (
            <tags.Progress
              label="Tests passed"
              value={passed}
              max={ran}
              valueText={`${passed} of ${ran}`}
              color={failed > 0 ? 'error' : 'success'}
            />
          )}
        </Box>
        {list.length === 0 && (
          <Text dimColor>
            {scanning ? 'Looking for test projects…' : 'No test projects found. Supported: .NET, pytest, Vitest, Claude Code mods.'}
          </Text>
        )}
        {list.length > 0 && (
          <Box flexDirection="column">
            {row(
              'header',
              0,
              'unknown',
              <Text bold dimColor>
                Test
              </Text>,
              'Duration',
            )}
            {TOOLS.filter(tool => list.some(p => p.tool === tool)).flatMap(tool => {
              const own = list.filter(p => p.tool === tool)
              const tests = own.flatMap(p => p.tests)
              const state = own.some(p => p.state !== 'idle') ? 'running' : 'idle'

              return [
                row(
                  tool,
                  0,
                  rollup(tests, state),
                  <Text bold>{TOOL_LABEL[tool]}</Text>,
                  duration(tests),
                ),
                ...own.flatMap(projectRows),
              ]
            })}
          </Box>
        )}
        {rows > MAX_ROWS && <Text dimColor>Showing the first {MAX_ROWS} tests; narrow the filter to see more.</Text>}
      </Box>
    )
  })
}
