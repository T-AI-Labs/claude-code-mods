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

const VALIDATED = `Validating hooks: C:\\mods\\catalog\\hooks\\hooks.json

  ❯ ./register.tsx hooks: session.start, ui.render{component=Pane, requestId=catalog}
  ❯ ./register.tsx calls: $.process.run (via cli), $.ui.open
`

const USER_HOOKS = {
  PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'rtk hook claude' }] }],
}

const FILES: Record<string, unknown> = {
  '/home/.claude/plugins/installed_plugins.json': {
    plugins: {
      'auto@thor-skills': [
        {
          installPath: '/plugins/auto',
          version: '0.3.0',
          installedAt: '2026-09-30T05:19:11.660Z',
          lastUpdated: '2026-09-30T05:49:16.332Z',
        },
      ],
      'meter@T-AI-Labs': [{ installPath: '/plugins/meter', version: '0.3.4' }],
      'agents-kit@workflows': [
        { installPath: '/plugins/agents-kit', version: '1.2.3', installedAt: '2026-08-01T10:00:00.000Z' },
      ],
    },
  },
  '/home/.claude/plugins/known_marketplaces.json': {
    'thor-skills': { source: { source: 'github', repo: 'thor/skills' }, installLocation: '/markets/thor' },
    workflows: { source: { source: 'github', repo: 'wshobson/agents' }, installLocation: '/markets/workflows' },
  },
  '/home/.claude/plugins/plugin-catalog-cache.json': {
    catalog: { plugins: { 'agents-kit@workflows': { unique_installs: 3474 } } },
  },
  '/markets/thor/.claude-plugin/marketplace.json': { plugins: [{ name: 'auto', source: './auto' }] },
  '/markets/thor/auto/.claude-plugin/plugin.json': { version: '0.4.0' },
  '/plugins/auto/.claude-plugin/plugin.json': { description: 'Ticket to PR automation' },
  '/plugins/agents-kit/.claude-plugin/plugin.json': { description: 'Python agents' },
  '/plugins/meter/.claude-plugin/plugin.json': { description: 'Cache hit rate above the prompt' },
  '/plugins/meter/hooks/hooks.json': { modules: ['./register.tsx'] },
  '/mods/catalog/.claude-plugin/plugin.json': { name: 'catalog-pane', description: 'The catalog', version: '0.3.0' },
  '/mods/catalog/hooks/hooks.json': { modules: ['./register.tsx'] },
}

const DIRS: Record<string, string[]> = {
  '/home/.claude/skills': ['find-skills'],
  '/plugins/auto/skills': ['fix'],
}

const REPOS: Record<string, Record<string, unknown>> = {
  'thor/skills': {
    stargazers_count: 1234,
    forks_count: 12,
    open_issues_count: 5,
    pushed_at: '2026-10-10T08:00:00Z',
    created_at: '2024-10-16T00:00:00Z',
    license: { spdx_id: 'MIT' },
  },
  'wshobson/agents': {
    stargazers_count: 40911,
    forks_count: 4000,
    open_issues_count: 2,
    pushed_at: '2026-10-15T15:11:55Z',
    created_at: '2025-07-16T00:00:00Z',
    license: { spdx_id: 'MIT' },
  },
}

// The fixtures are POSIX paths; on Windows the engine resolves them onto the current drive.
const slash = (path: string) => path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')

const world = (on: On, stored: Record<string, unknown> = {}) => {
  const filled: string[] = []
  const ran: string[] = []
  const opened: string[] = []
  const commands: string[] = []
  const fetched: string[] = []
  const clock = mock.clock(on, { now: Date.parse('2026-10-16T10:00:00Z') })
  mock.store(on, stored)
  mock.env(on, { USERPROFILE: '/home', CLAUDE_CODE_PLUGIN_DIRS: '/mods/catalog' })
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
  on('settings.read', ($, e) =>
    e.source === 'user'
      ? { value: { hooks: USER_HOOKS } }
      : { value: { enabledPlugins: { 'auto@thor-skills': true, 'meter@T-AI-Labs': true } } },
  )
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
    const stdout = e.argv.includes('details') ? DETAILS : e.argv.includes('validate') ? VALIDATED : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    const body = REPOS[e.url.replace('https://api.github.com/repos/', '')] ?? {}

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

  expect((await ui.find({ key: 'open-plugin:auto' }))?.text).toMatch(/~1.6k tok\/session · ★ 1.2k · update/)

  await ui.press({ key: 'open-plugin:auto' })

  expect(commands).toContain('claude plugin details auto@thor-skills')
  expect(fetched).toContain('https://api.github.com/repos/thor/skills')
  expect(await ui.find({ type: 'Text', text: /~1.6k tokens in every session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /v0.3.0 · enabled · installed 2026-09-30/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Update available: v0.4.0/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /★ 1,234 · ~51 ★ a month on average · 12 forks · 5 open issues · last push 2026-10-10 · MIT/ })).toBeDefined()
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

test('opens the pane only on /catalog, not when a session starts or the desktop app attaches', async ($, on) => {
  const { opened, clock } = world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })

  expect(opened).toEqual([])

  await $.command.run({ ...TYPED, command: 'catalog', args: '' })

  expect(opened).toEqual(['catalog'])
  await clock.settle()
})

test('lists mods apart from plugins with what each one hooks and calls', async ($, on) => {
  const { commands, clock } = world(on)
  await openCatalog($, 'mods')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ key: 'tab-mod' }))?.props.label).toBe('Mods 2')
  expect((await ui.find({ key: 'tab-plugin' }))?.props.label).toBe('Plugins 2')
  expect(await ui.find({ key: 'open-mod:meter' })).toBeDefined()

  await ui.press({ key: 'open-mod:catalog-pane' })

  expect(commands).toContain('claude plugin validate /mods/catalog')
  expect(await ui.find({ type: 'Text', text: /Loaded from \/mods\/catalog through CLAUDE_CODE_PLUGIN_DIRS, v0\.3\.0/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Hooks: session\.start, ui\.render\{component=Pane, requestId=catalog\}/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Uses: \$\.process\.run \(via cli\), \$\.ui\.open/ })).toBeDefined()
  await ui.unmount()
})

test('lists the hooks from the settings with their command', async ($, on) => {
  const { clock } = world(on)
  await openCatalog($, 'hooks')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-hook:user:PreToolUse:0:0' })

  expect(await ui.find({ type: 'Text', text: 'PreToolUse · Bash|PowerShell' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /command hook from the user settings/ })).toBeDefined()
  expect((await ui.find({ key: 'about' }))?.props.text).toBe('`rtk hook claude`')
  await ui.unmount()
})

const rowKeys = async (ui: { findAll: (query: { type: string }) => Promise<{ key: string | undefined }[]> }) =>
  (await ui.findAll({ type: 'Button' })).flatMap(one => (one.key?.startsWith('open-') ? [one.key] : []))

test('sorts plugins by GitHub stars, installs and install date', async ($, on) => {
  const { clock } = world(on)
  await openCatalog($, 'plugins')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'sort', value: 'stars' })

  expect(await rowKeys(ui)).toEqual(['open-plugin:agents-kit', 'open-plugin:auto'])
  expect((await ui.find({ key: 'open-plugin:agents-kit' }))?.text).toMatch(/★ 40.9k/)

  await ui.select({ key: 'sort', value: 'installed' })

  expect(await rowKeys(ui)).toEqual(['open-plugin:auto', 'open-plugin:agents-kit'])
  expect((await ui.find({ key: 'open-plugin:auto' }))?.text).toMatch(/installed 2026-09-30/)

  await ui.select({ key: 'sort', value: 'installs' })

  expect(await rowKeys(ui)).toEqual(['open-plugin:agents-kit', 'open-plugin:auto'])
  expect((await ui.find({ key: 'open-plugin:agents-kit' }))?.text).toMatch(/3.5k installs/)
  await ui.unmount()
})

test('ranks skills by the stars of the plugin they come from', async ($, on) => {
  const { clock } = world(on)
  await openCatalog($, 'skills')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'sort', value: 'stars' })

  expect(await rowKeys(ui)).toEqual(['open-skill:auto:fix', 'open-skill:find-skills'])
  expect((await ui.find({ key: 'open-skill:auto:fix' }))?.text).toMatch(/★ 1.2k/)
  await ui.unmount()
})

test('measures trending from the stored star history, else from the repo age', async ($, on) => {
  const history = {
    stars: 1000,
    forks: 0,
    issues: 0,
    pushedAt: '',
    createdAt: '2024-10-16T00:00:00Z',
    history: [{ day: '2026-09-16', stars: 1000 }],
    fetchedAt: 0,
  }
  const { clock } = world(on, { repos: { 'thor/skills': history } })
  await openCatalog($, 'plugins')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'sort', value: 'trending' })

  expect(await rowKeys(ui)).toEqual(['open-plugin:agents-kit', 'open-plugin:auto'])
  expect((await ui.find({ key: 'open-plugin:auto' }))?.text).toMatch(/\+231 ★ a month/)
  expect((await ui.find({ key: 'open-plugin:agents-kit' }))?.text).toMatch(/~2.7k ★ a month on average/)
  await ui.unmount()
})

test('draws labelled buttons at footnote size and keeps the rows as they are', async ($, on) => {
  const { clock } = world(on)
  await openCatalog($, 'tools')
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: 'Skills 2' }))?.props.size).toBe('footnote')
    expect((await ui.find({ key: 'open-tool:Bash' }))?.children[0]).toBe('Bash')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-tool:Bash' })
  expect((await ui.find({ type: 'Text', text: 'Explain with Haiku' }))?.props.size).toBe('footnote')
  await ui.unmount()
})
