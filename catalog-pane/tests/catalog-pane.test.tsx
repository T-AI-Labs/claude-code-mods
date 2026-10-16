import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const TYPED = {
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const
const PANE = {
  plugin: 'catalog-pane',
  component: 'Pane',
  requestId: 'catalog',
  props: {
    title: 'Catalog',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const DETAILS = `auto 0.3.0
  Description: Ticket to PR automation

Projected token cost
  Always-on:   ~1,648 tok   added to every session

Per-component (rounded)
  component                        always-on  on-invoke
  fix                                    ~80      ~2.7k
`

const FILES: Record<string, unknown> = {
  'C:/home/.claude/plugins/installed_plugins.json': {
    plugins: {
      'auto@thor-skills': [
        {
          installPath: 'C:/plugins/auto',
          version: '0.3.0',
          installedAt: '2026-09-30T05:19:11.660Z',
          lastUpdated: '2026-09-30T05:49:16.332Z',
        },
      ],
    },
  },
  'C:/home/.claude/plugins/known_marketplaces.json': {
    'thor-skills': { source: { source: 'github', repo: 'thor/skills' }, installLocation: 'C:/markets/thor' },
  },
  'C:/markets/thor/.claude-plugin/marketplace.json': { plugins: [{ name: 'auto', source: './auto' }] },
  'C:/markets/thor/auto/.claude-plugin/plugin.json': { version: '0.4.0' },
  'C:/plugins/auto/.claude-plugin/plugin.json': { description: 'Ticket to PR automation' },
}

const DIRS: Record<string, string[]> = {
  'C:/home/.claude/skills': ['find-skills'],
  'C:/plugins/auto/skills': ['fix'],
}

const slash = (path: string) => path.replaceAll('\\', '/')

const world = (on: On) => {
  const filled: string[] = []
  const ran: string[] = []
  const opened: string[] = []
  const commands: string[] = []
  const fetched: string[] = []
  const clock = mock.clock(on, { now: Date.parse('2026-10-16T10:00:00Z') })
  mock.store(on, {})
  mock.env(on, { USERPROFILE: 'C:/home' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({
    value: [
      { name: 'simplify', description: 'Review changed code for reuse', source: 'builtin' },
      { name: 'review', description: 'Review a pull request', source: 'builtin' },
      { name: 'find-skills', description: 'Discover agent skills', source: 'user' },
      { name: 'auto:fix', description: 'Fix a bug from its ticket', source: 'plugin', plugin: 'auto' },
    ],
  }))
  on('tool.list', () => ({
    value: [
      { name: 'Bash', description: 'Runs a shell command.\n\nLong details.', mcp: false },
      { name: 'mcp__context7__query-docs', description: 'Query docs', mcp: true },
      { name: 'mcp__claude_ai_Gmail__send', description: 'Send mail', mcp: true },
    ],
  }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'auto@thor-skills': true } } }))
  on('fs.list', ($, e) => {
    const names = DIRS[slash(e.path)]

    return names === undefined
      ? { deny: 'ENOENT' }
      : { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => {
    const file = FILES[slash(e.path)]

    return file === undefined ? { deny: 'ENOENT' } : { value: JSON.stringify(file) }
  })
  on('process.run', ($, e) => {
    commands.push(e.argv.join(' '))
    const stdout = e.argv.includes('details') ? DETAILS : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    const body = { stargazers_count: 1234, open_issues_count: 5, pushed_at: '2026-10-10T08:00:00Z', license: { spdx_id: 'MIT' } }

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('command.run', ($, e) => {
    ran.push(e.command)

    return { text: '' }
  })

  return { filled, ran, opened, commands, fetched, clock }
}

const openCatalog = async ($: Engine, args = '') => {
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'catalog', args })
}

test('lists each category with its count and describes the entries', async ($, on) => {
  const { clock } = world(on)
  await openCatalog($)
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ key: 'tab-skill' }))?.props.label).toBe('Skills 2')
    expect((await ui.find({ key: 'tab-command' }))?.props.label).toBe('Commands 2')
    expect((await ui.find({ key: 'tab-mcp' }))?.props.label).toBe('MCP 2')
    expect(await ui.find({ type: 'Text', text: 'Discover agent skills' })).toBeDefined()
    await ui.unmount()
  }
})

test('counts command runs and sorts the most used first', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'review' })
  await $.command.run({ ...TYPED, command: 'catalog', args: 'commands' })
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('open-'))

    expect(rows[0]?.key).toBe('open-command:review')
    expect(rows[0]?.text).toMatch(/1× \(1 in 30d\)/)
    await ui.unmount()
  }
})

test('keeps 7- and 30-day counts once the counts are saved', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'review' })
  await clock.advance(10_000)
  await $.command.run({ ...TYPED, command: 'catalog', args: 'commands' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-command:review' })

  expect(await ui.find({ type: 'Text', text: /Used 1× · 1 in 7 days · 1 in 30 days · last 2026-10-16/ })).toBeDefined()
  await ui.unmount()
})

test('offers to insert a command first and to run it second', async ($, on) => {
  const { filled, ran, clock } = world(on)
  await openCatalog($, 'commands')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-command:review' })

  expect((await ui.find({ key: 'insert' }))?.props.variant).toBe('primary')

  await ui.press({ key: 'insert' })
  await ui.press({ key: 'run' })

  expect(filled).toEqual(['/review '])
  expect(ran).toContain('review')
  await ui.unmount()
})

test('opens an entry, navigates back and inserts it into the prompt', async ($, on) => {
  const { filled, clock } = world(on)
  await openCatalog($, 'tools')
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open-tool:Bash' })

    expect(await ui.find({ type: 'Text', text: 'Bash' })).toBeDefined()
    expect(await ui.find({ key: 'explain' })).toBeDefined()

    await ui.press({ key: 'insert' })
    await ui.press({ key: 'back' })

    expect(await ui.find({ key: 'open-tool:Bash' })).toBeDefined()
    await ui.unmount()
  }

  expect(filled).toEqual(['Use the Bash tool to ', 'Use the Bash tool to '])
})

test('filters the list on the desktop', async ($, on) => {
  const { clock } = world(on)
  await openCatalog($, 'commands')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'query', text: 'pull', kind: 'change' })

  expect(await ui.find({ key: 'open-command:review' })).toBeDefined()
  expect(await ui.find({ key: 'open-command:simplify' })).toBeUndefined()
  await ui.unmount()
})

test('shows a plugin with its token cost, update, installs and GitHub stats', async ($, on) => {
  const { commands, fetched, clock } = world(on)
  await openCatalog($, 'plugins')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ key: 'open-plugin:auto' }))?.text).toMatch(/~1.6k tok\/session · update/)

  await ui.press({ key: 'open-plugin:auto' })

  expect(commands).toContain('claude plugin details auto@thor-skills')
  expect(fetched).toEqual(['https://api.github.com/repos/thor/skills'])
  expect(await ui.find({ type: 'Text', text: /~1.6k tokens in every session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /v0.3.0 · enabled · installed 2026-09-30/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Update available: v0.4.0/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /★ 1,234 · 5 open issues · last push 2026-10-10 · MIT/ })).toBeDefined()
  expect((await ui.find({ key: 'item-skill:auto:fix' }))?.text).toMatch(/~80 tok\/session/)
  await ui.unmount()
})

test('asks before uninstalling a plugin and then runs the CLI', async ($, on) => {
  const { commands, clock } = world(on)
  await openCatalog($, 'plugins')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-plugin:auto' })
  await ui.press({ key: 'uninstall' })

  expect(commands).not.toContain('claude plugin uninstall auto@thor-skills')
  expect(await ui.find({ type: 'Text', text: /Uninstall auto@thor-skills\?/ })).toBeDefined()

  await ui.press({ key: 'cancel' })

  expect(await ui.find({ key: 'confirm' })).toBeUndefined()

  await ui.press({ key: 'uninstall' })
  await ui.press({ key: 'confirm' })

  expect(commands).toContain('claude plugin uninstall auto@thor-skills')
  await ui.unmount()
})

test('disables and updates a plugin without asking', async ($, on) => {
  const { commands, clock } = world(on)
  await openCatalog($, 'plugins')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-plugin:auto' })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'update' })

  expect(commands).toContain('claude plugin disable auto@thor-skills')
  expect(commands).toContain('claude plugin update auto@thor-skills')
  await ui.unmount()
})

test('removes a local MCP server after asking, but not a claude.ai connector', async ($, on) => {
  const { commands, clock } = world(on)
  await openCatalog($, 'mcp')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-mcp:claude_ai_Gmail' })

  expect(await ui.find({ key: 'remove' })).toBeUndefined()

  await ui.press({ key: 'back' })
  await ui.press({ key: 'open-mcp:context7' })
  await ui.press({ key: 'remove' })
  await ui.press({ key: 'confirm' })

  expect(commands).toContain('claude mcp remove context7')
  await ui.unmount()
})

test('sorts costly and unused entries first for clean-up', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'find-skills' })
  await $.command.run({ ...TYPED, command: 'catalog', args: 'skills' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'sort', value: 'cleanup' })
  const rows = (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('open-'))

  expect(rows.map(one => one.key)).toEqual(['open-skill:auto:fix', 'open-skill:find-skills'])
  await ui.unmount()
})

test('fetches nothing from GitHub when the option is off', { options: { githubStats: false } }, async ($, on) => {
  const { fetched, clock } = world(on)
  await openCatalog($, 'plugins')
  await clock.settle()

  expect(fetched).toEqual([])
})

test('opens the pane by itself when the desktop app attaches, not in the terminal', async ($, on) => {
  const { opened, clock } = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect(opened).toEqual([])

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })

  expect(opened).toEqual(['catalog'])
  await clock.settle()
})
