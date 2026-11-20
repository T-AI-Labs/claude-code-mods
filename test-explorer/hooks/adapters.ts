import type { Status, TestCase, Tool } from '../types'

export type Outcome = { name: string; group?: string; status: Status; ms?: number; message?: string }

export const TOOL_LABEL: Record<Tool, string> = {
  dotnet: '.NET',
  pytest: 'pytest',
  vitest: 'Vitest',
  jest: 'Jest',
  mocha: 'Mocha',
  playwright: 'Playwright',
  go: 'Go',
  cargo: 'Rust',
  maven: 'Maven',
  gradle: 'Gradle',
  rspec: 'RSpec',
  'claude-plugin': 'Claude Code mods',
}

const MAX_MESSAGE = 4000

const plain = (text: string) =>
  text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

const lines = (text: string) => plain(text).split(/\r?\n/)

const append = (outcome: Outcome | undefined, line: string) => {
  if (!outcome || (outcome.message?.length ?? 0) > MAX_MESSAGE) return
  outcome.message = outcome.message === undefined ? line : `${outcome.message}\n${line}`
}

const duration = (text: string | undefined) => {
  const hit = /([\d.]+)\s*(ms|s|m)?/.exec(text ?? '')
  if (!hit) return undefined
  const value = Number(hit[1])

  return hit[2] === 's' ? value * 1000 : hit[2] === 'm' ? value * 60000 : value
}

const unknown = (name: string, group: string): TestCase => ({ name, group, status: 'unknown' })

export const dotnetGroup = (name: string) => {
  const base = name.split('(')[0] ?? name
  const dot = base.lastIndexOf('.')

  return dot > 0 ? base.slice(0, dot) : ''
}

export const parseDotnetList = (out: string): TestCase[] => {
  const all = lines(out)
  const start = all.findIndex(l => l.includes('The following Tests are available'))
  if (start < 0) return []

  return all
    .slice(start + 1)
    .map(l => l.trim())
    .filter(Boolean)
    .map(name => unknown(name, dotnetGroup(name)))
}

const DOTNET_STATUS: Record<string, Status> = { Passed: 'passed', Failed: 'failed', Skipped: 'skipped' }

export const parseDotnetRun = (out: string): Outcome[] => {
  const outcomes: Outcome[] = []
  let current: Outcome | undefined
  let isDetail = false
  for (const line of lines(out)) {
    const hit = /^\s+(Passed|Failed|Skipped)\s+(.+?)\s+\[([^\]]+)\]\s*$/.exec(line)
    if (hit) {
      current = { name: hit[2]!, status: DOTNET_STATUS[hit[1]!]!, ms: duration(hit[3]) }
      outcomes.push(current)
      isDetail = false
    } else if (/^\s+(Error Message|Stack Trace):\s*$/.test(line)) {
      isDetail = true
      if (line.includes('Stack Trace')) append(current, 'Stack trace:')
    } else if (line.trim() === '') {
      isDetail = false
    } else if (isDetail) {
      append(current, line.trim())
    }
  }

  return outcomes
}

const pytestGroup = (nodeId: string) => nodeId.slice(0, Math.max(0, nodeId.lastIndexOf('::')))

export const parsePytestList = (out: string): TestCase[] => {
  const tests: TestCase[] = []
  for (const line of lines(out)) {
    if (line.trim() === '') break
    if (line.includes('::')) tests.push(unknown(line.trim(), pytestGroup(line.trim())))
  }

  return tests
}

const PYTEST_STATUS: Record<string, Status> = {
  PASSED: 'passed',
  FAILED: 'failed',
  ERROR: 'failed',
  XFAIL: 'skipped',
  XPASS: 'passed',
}

export const parsePytestRun = (out: string): Outcome[] => {
  const outcomes: Outcome[] = []
  const details = new Map<string, string[]>()
  let block: string[] | undefined
  for (const line of lines(out)) {
    const header = /^_{3,} (.+?) _{3,}$/.exec(line)
    if (header) {
      block = []
      details.set(header[1]!.replace(/^ERROR (at \w+ of )?/, ''), block)
      continue
    }
    if (/^={3,}/.test(line)) block = undefined
    block?.push(line)
    const hit = /^(PASSED|FAILED|ERROR|XFAIL|XPASS) (\S+::\S+)/.exec(line)
    if (hit) outcomes.push({ name: hit[2]!, group: pytestGroup(hit[2]!), status: PYTEST_STATUS[hit[1]!]! })
  }
  for (const outcome of outcomes) {
    const dotted = outcome.name.split('::').slice(1).join('.')
    const detail = [...details].find(([title]) => dotted === title || dotted.endsWith(`.${title}`))?.[1]
    if (detail) outcome.message = detail.join('\n').slice(0, MAX_MESSAGE)
  }

  return outcomes
}

const relative = (dir: string, file: string) => {
  const f = file.replace(/\\/g, '/')
  const d = dir.replace(/\\/g, '/')

  return f.toLowerCase().startsWith(`${d.toLowerCase()}/`) ? f.slice(d.length + 1) : f
}

const json = (out: string, open: string, close: string) => {
  const start = out.indexOf(open)
  const end = out.lastIndexOf(close)

  return start < 0 || end < start ? undefined : (JSON.parse(out.slice(start, end + 1)) as unknown)
}

export const parseVitestList = (out: string, dir: string): TestCase[] => {
  const list = json(out, '[', ']') as { name: string; file: string }[] | undefined

  return (list ?? []).map(t => unknown(t.name, relative(dir, t.file)))
}

type VitestReport = {
  testResults?: {
    name: string
    message?: string
    assertionResults?: {
      title: string
      ancestorTitles?: string[]
      status: string
      duration?: number | null
      failureMessages?: string[]
    }[]
  }[]
}

const VITEST_STATUS: Record<string, Status> = { passed: 'passed', failed: 'failed' }

export const parseVitestRun = (out: string, dir: string): Outcome[] => {
  const report = json(out, '{', '}') as VitestReport | undefined

  return (report?.testResults ?? []).flatMap(file =>
    (file.assertionResults ?? []).map(t => ({
      name: [...(t.ancestorTitles ?? []), t.title].join(' > '),
      group: relative(dir, file.name),
      status: VITEST_STATUS[t.status] ?? 'skipped',
      ms: t.duration ?? undefined,
      message: t.failureMessages?.length ? plain(t.failureMessages.join('\n')).slice(0, MAX_MESSAGE) : undefined,
    })),
  )
}

export const parsePluginTestSource = (source: string, file: string): TestCase[] =>
  [...source.matchAll(/\btest(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map(m => unknown(m[2]!, file))

const PLUGIN_STATUS: Record<string, Status> = { pass: 'passed', fail: 'failed', skip: 'skipped', todo: 'skipped' }

export const parsePluginTestRun = (out: string): Outcome[] => {
  const outcomes: Outcome[] = []
  let group: string | undefined
  let current: Outcome | undefined
  for (const line of lines(out)) {
    const file = /^(\S.*\.test\.[cm]?[jt]sx?):$/.exec(line)
    const hit = /^\((pass|fail|skip|todo)\) (.+?)(?: \[([\d.]+)ms\])?$/.exec(line)
    if (file) {
      group = file[1]!.split(/[\\/]/).pop()
      current = undefined
    } else if (hit) {
      current = { name: hit[2]!, group, status: PLUGIN_STATUS[hit[1]!]!, ms: duration(hit[3]) }
      outcomes.push(current)
    } else if (current?.status === 'failed' && /^\s/.test(line) && line.trim() !== '') {
      append(current, line.trim())
    } else if (line.trim() === '') {
      current = undefined
    }
  }

  return outcomes
}

type MochaTest = { title: string; fullTitle: string; file?: string; duration?: number; err?: { message?: string; stack?: string } }
type MochaReport = { tests?: MochaTest[]; failures?: MochaTest[]; pending?: MochaTest[] }

const mochaKey = (t: MochaTest) => `${t.file ?? ''}|${t.fullTitle}`

export const parseMochaRun = (out: string, dir: string): Outcome[] => {
  const report = json(out, '{', '}') as MochaReport | undefined
  const failed = new Set((report?.failures ?? []).map(mochaKey))
  const pending = new Set((report?.pending ?? []).map(mochaKey))

  return (report?.tests ?? []).map(t => ({
    name: t.fullTitle,
    group: t.file === undefined ? '' : relative(dir, t.file),
    status: failed.has(mochaKey(t)) ? 'failed' : pending.has(mochaKey(t)) ? 'skipped' : 'passed',
    ms: t.duration,
    message: failed.has(mochaKey(t)) ? plain(t.err?.stack ?? t.err?.message ?? '').slice(0, MAX_MESSAGE) || undefined : undefined,
  }))
}

export const parseMochaList = (out: string, dir: string): TestCase[] =>
  parseMochaRun(out, dir).map(o => unknown(o.name, o.group ?? ''))

type PlaywrightResult = { status?: string; duration?: number; error?: { message?: string } }
type PlaywrightSpec = { title: string; file?: string; tests?: { projectName?: string; status?: string; results?: PlaywrightResult[] }[] }
type PlaywrightSuite = { title: string; file?: string; specs?: PlaywrightSpec[]; suites?: PlaywrightSuite[] }

const PLAYWRIGHT_STATUS: Record<string, Status> = { expected: 'passed', flaky: 'passed', unexpected: 'failed', skipped: 'skipped' }

const playwrightOutcomes = (out: string, dir: string, withResults: boolean): Outcome[] => {
  const report = json(out, '{', '}') as { suites?: PlaywrightSuite[] } | undefined
  const found: Outcome[] = []
  const walk = (suite: PlaywrightSuite, path: string[], file: string) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) {
        const last = t.results?.at(-1)
        const name = [...path, spec.title].join(' > ') + (t.projectName ? ` [${t.projectName}]` : '')
        found.push({
          name,
          group: relative(dir, spec.file ?? file),
          status: withResults ? (PLAYWRIGHT_STATUS[t.status ?? ''] ?? 'unknown') : 'unknown',
          ms: withResults ? last?.duration : undefined,
          message: withResults && last?.error?.message ? plain(last.error.message).slice(0, MAX_MESSAGE) : undefined,
        })
      }
    for (const child of suite.suites ?? []) walk(child, [...path, child.title], child.file ?? file)
  }
  // Top-level suites are the files: their titles are the file names, not part of a test's name.
  for (const file of report?.suites ?? []) walk(file, [], file.file ?? file.title)

  return found
}

export const parsePlaywrightList = (out: string, dir: string): TestCase[] =>
  playwrightOutcomes(out, dir, false).map(o => unknown(o.name, o.group ?? ''))

export const parsePlaywrightRun = (out: string, dir: string): Outcome[] => playwrightOutcomes(out, dir, true)

export const parseGoList = (out: string): TestCase[] => {
  const tests: TestCase[] = []
  let names: string[] = []
  for (const line of lines(out)) {
    const done = /^(?:ok|\?|FAIL)\s+(\S+)/.exec(line)
    if (done) {
      tests.push(...names.map(name => unknown(name, done[1]!)))
      names = []
    } else if (/^(Test|Example|Fuzz)\w*$/.test(line.trim())) {
      names.push(line.trim())
    }
  }

  return tests
}

type GoEvent = { Action?: string; Package?: string; Test?: string; Elapsed?: number; Output?: string }

const GO_STATUS: Record<string, Status> = { pass: 'passed', fail: 'failed', skip: 'skipped' }

export const parseGoRun = (out: string): Outcome[] => {
  const outcomes = new Map<string, Outcome>()
  const output = new Map<string, string[]>()
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    let event: GoEvent
    try {
      event = JSON.parse(line) as GoEvent
    } catch {
      continue
    }
    if (!event.Test || !event.Package) continue
    const key = `${event.Package}|${event.Test}`
    if (event.Action === 'output' && event.Output) output.set(key, [...(output.get(key) ?? []), event.Output.replace(/\n$/, '')])
    const status = GO_STATUS[event.Action ?? '']
    if (status) {
      const message = status === 'failed' ? plain((output.get(key) ?? []).join('\n')).slice(0, MAX_MESSAGE) : undefined
      outcomes.set(key, {
        name: event.Test,
        group: event.Package,
        status,
        ms: event.Elapsed === undefined ? undefined : event.Elapsed * 1000,
        message,
      })
    }
  }

  return [...outcomes.values()]
}

const rustGroup = (name: string) => name.slice(0, Math.max(0, name.lastIndexOf('::')))

export const parseCargoList = (out: string): TestCase[] =>
  lines(out)
    .map(line => /^(\S+): test$/.exec(line.trim())?.[1])
    .filter(name => name !== undefined)
    .map(name => unknown(name, rustGroup(name)))

const CARGO_STATUS: Record<string, Status> = { ok: 'passed', FAILED: 'failed', ignored: 'skipped' }

export const parseCargoRun = (out: string): Outcome[] => {
  const outcomes: Outcome[] = []
  const details = new Map<string, string[]>()
  let block: string[] | undefined
  for (const line of lines(out)) {
    const hit = /^test (\S+) \.\.\. (ok|FAILED|ignored)/.exec(line)
    const header = /^---- (\S+) stdout ----$/.exec(line)
    if (hit) {
      outcomes.push({ name: hit[1]!, group: rustGroup(hit[1]!), status: CARGO_STATUS[hit[2]!]! })
    } else if (header) {
      block = []
      details.set(header[1]!, block)
    } else if (/^(failures:|test result:)/.test(line)) {
      block = undefined
    } else {
      block?.push(line)
    }
  }
  for (const outcome of outcomes) {
    const detail = details.get(outcome.name)
    if (outcome.status === 'failed' && detail) outcome.message = detail.join('\n').trim().slice(0, MAX_MESSAGE)
  }

  return outcomes
}

const xmlText = (text: string) =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')

const attribute = (tag: string, name: string) => {
  const hit = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)

  return hit ? xmlText(hit[1]!) : undefined
}

// JUnit XML, as Maven Surefire and Gradle write it: one file per test class.
export const parseJunitXml = (xml: string): Outcome[] =>
  [...xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)].map(m => {
    const tag = m[1] ?? ''
    const body = m[3] ?? ''
    const problem = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body)
    const classname = attribute(tag, 'classname') ?? ''
    const seconds = Number(attribute(tag, 'time'))

    return {
      name: attribute(tag, 'name') ?? '',
      group: classname,
      status: problem ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed',
      ms: Number.isFinite(seconds) ? seconds * 1000 : undefined,
      message: problem
        ? [attribute(problem[2] ?? '', 'message'), xmlText(problem[3] ?? '').trim()].filter(Boolean).join('\n').slice(0, MAX_MESSAGE)
        : undefined,
    }
  })

type RspecExample = {
  full_description: string
  file_path?: string
  status?: string
  run_time?: number
  exception?: { class?: string; message?: string }
}

const RSPEC_STATUS: Record<string, Status> = { passed: 'passed', failed: 'failed', pending: 'skipped' }

export const parseRspecRun = (out: string): Outcome[] => {
  const report = json(out, '{', '}') as { examples?: RspecExample[] } | undefined

  return (report?.examples ?? []).map(e => ({
    name: e.full_description,
    group: (e.file_path ?? '').replace(/^\.\//, ''),
    status: RSPEC_STATUS[e.status ?? ''] ?? 'skipped',
    ms: e.run_time === undefined ? undefined : e.run_time * 1000,
    message: e.exception ? plain([e.exception.class, e.exception.message].filter(Boolean).join(': ')).slice(0, MAX_MESSAGE) : undefined,
  }))
}

export const parseRspecList = (out: string): TestCase[] => parseRspecRun(out).map(o => unknown(o.name, o.group ?? ''))

export const merge = (tests: readonly TestCase[], outcomes: readonly Outcome[]): TestCase[] => {
  const merged: TestCase[] = tests.map(t => ({ ...t, status: 'unknown', ms: undefined, message: undefined }))
  for (const o of outcomes) {
    const same = (t: TestCase) => o.group === undefined || t.group === o.group
    const index = [
      merged.findIndex(t => t.name === o.name && same(t)),
      merged.findIndex(t => t.name.endsWith(`.${o.name}`) && same(t)),
    ].find(i => i >= 0)
    const result = { status: o.status, ms: o.ms, message: o.message }
    if (index === undefined) merged.push({ name: o.name, group: o.group ?? '', ...result })
    else merged[index] = { ...merged[index]!, ...result }
  }

  return merged
}
