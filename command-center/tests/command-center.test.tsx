import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  plugin: 'command-center',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const AGENTS = {
  agents: {
    Explore: { name: 'Explore', description: 'Searches the codebase', source: 'Built-in' },
    Plan: { name: 'Plan', description: 'Designs a plan', source: 'Built-in' },
  },
}

// The fixtures are POSIX paths; on Windows the engine resolves them onto the current drive.
const slash = (path: string) => path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')

const DIRS: Record<string, string[]> = {
  '/home/.claude/skills': ['find-skills'],
  '/plugins/auto/skills': ['fix'],
  '/work/.claude/skills': ['release'],
  '/work/.claude/commands': ['deploy.md', 'db', 'notes.txt'],
  '/work/.claude/commands/db': ['migrate.md'],
}

const FILES: Record<string, unknown> = {
  '/home/.claude/plugins/installed_plugins.json': {
    plugins: { 'auto@thor-skills': [{ installPath: '/plugins/auto' }] },
  },
}

const COMMANDS = [
  { name: 'simplify', description: 'Review changed code', source: 'builtin' },
  { name: 'compact', description: 'Compact the conversation', source: 'builtin' },
  { name: 'find-skills', description: 'Discover agent skills', source: 'user' },
  { name: 'auto:fix', description: 'Fix a bug', source: 'plugin', plugin: 'auto' },
  { name: 'review-pr', description: 'Review a pull request', source: 'plugin', plugin: 'gh-tools' },
] as const

type World = { draft?: string; stored?: Record<string, unknown>; commands?: readonly object[] }

const world = (on: On, options: World = {}) => {
  const filled: string[] = []
  const ran: { command: string; args: string }[] = []
  const spawned: { prompt: string; subagentType: string }[] = []
  mock.clock(on, { now: Date.parse('2026-11-08T10:00:00Z') })
  mock.store(on, options.stored ?? AGENTS)
  mock.env(on, { USERPROFILE: '/home' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/work' }))
  on('turn.complete', () => ({}))
  on('command.list', () => ({ value: [...COMMANDS, ...(options.commands ?? [])] }))
  on('fs.list', ($, e) => {
    const names = DIRS[slash(e.path)]

    return names === undefined
      ? { deny: 'ENOENT' }
      : {
          value: names.map(name => ({
            name,
            kind: name.includes('.') ? 'file' : 'dir',
            size: 0,
            mtimeMs: 0,
            isLink: false,
          })),
        }
  })
  on('fs.read', ($, e) => {
    const file = FILES[slash(e.path)]

    return file === undefined ? { deny: 'ENOENT' } : { value: JSON.stringify(file) }
  })
  on('prompt.read', () => ({ value: { text: options.draft ?? '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('command.run', ($, e) => {
    ran.push({ command: e.command, args: e.args })

    return { text: '' }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('agent.spawn', ($, e) => {
    // With no engine beneath, the call arrives in the Agent tool's own shape.
    const raw = e as unknown as { subagent_type?: string }
    spawned.push({ prompt: e.prompt, subagentType: e.subagentType ?? raw.subagent_type ?? '' })

    return { model: 'claude-opus-5-5', agentId: 'agent-1' }
  })
  on('agent.offer', () => ({ isOffered: true }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>below</Text>
  })

  return { filled, ran, spawned }
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

const values = (props: Record<string, unknown>) =>
  (props.options as { value: string }[]).map(one => one.value)

test('puts the dropdowns and both buttons in one row under the rows beneath', async ($, on) => {
  world(on)
  await start($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
    expect((await ui.findAll({ type: 'Select' })).map(one => one.key)).toEqual([
      'source',
      'agent',
      'skill',
      'command',
    ])
    expect((await ui.findAll({ type: 'Button' })).map(one => one.key)).toEqual(['insert', 'run'])
    await ui.unmount()
  }
})

test('tells skills from commands by their folders and lists the agents seen before', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(values((await ui.find({ type: 'Select', key: 'agent' }))!.props)).toEqual(['-', 'Explore', 'Plan'])
  expect(values((await ui.find({ type: 'Select', key: 'skill' }))!.props)).toEqual(['-', 'auto:fix', 'find-skills'])
  expect(values((await ui.find({ type: 'Select', key: 'command' }))!.props)).toEqual([
    '-',
    'compact',
    'review-pr',
    'simplify',
  ])
  await ui.unmount()
})

test('narrows every dropdown to the source picked, and drops only the picks from another', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const shown = async (key: string) => {
    const picker = await ui.find({ type: 'Select', key })

    return { options: values(picker!.props), value: picker!.props.value }
  }

  expect((await shown('source')).options).toEqual(['*', 'auto', 'Built-in', 'gh-tools', 'User'])
  await ui.select({ key: 'agent', value: 'Explore' })
  await ui.select({ key: 'skill', value: 'auto:fix' })
  await ui.select({ key: 'command', value: 'compact' })
  await ui.select({ key: 'source', value: 'Built-in' })

  expect(await shown('agent')).toEqual({ options: ['-', 'Explore', 'Plan'], value: 'Explore' })
  expect(await shown('skill')).toEqual({ options: ['-'], value: '-' })
  expect(await shown('command')).toEqual({ options: ['-', 'compact', 'simplify'], value: 'compact' })

  await ui.select({ key: 'source', value: 'gh-tools' })
  expect(await shown('agent')).toEqual({ options: ['-'], value: '-' })
  expect(await shown('command')).toEqual({ options: ['-', 'review-pr'], value: '-' })
  await ui.unmount()
})

test('gives the row two text rows of height on the desktop for its taller controls', async ($, on) => {
  world(on)
  await start($)
  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const row = (await desktop.findAll({ type: 'Box' })).find(one => one.props.minHeight !== undefined)
  expect(row?.props.minHeight).toBe(2)
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await terminal.findAll({ type: 'Box' })).some(one => one.props.minHeight !== undefined)).toBe(false)
  await terminal.unmount()
})

test("files the repository's own skills and commands under Project", async ($, on) => {
  world(on, {
    commands: [
      { name: 'release', description: 'Cut a release', source: 'user' },
      { name: 'deploy', description: 'Deploy the app', source: 'user' },
      { name: 'migrate', description: 'Run migrations', source: 'user' },
    ],
  })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.select({ key: 'source', value: 'Project' })

  expect(values((await ui.find({ type: 'Select', key: 'skill' }))!.props)).toEqual(['-', 'release'])
  expect(values((await ui.find({ type: 'Select', key: 'command' }))!.props)).toEqual(['-', 'deploy', 'migrate'])

  await ui.select({ key: 'source', value: 'User' })
  expect(values((await ui.find({ type: 'Select', key: 'skill' }))!.props)).toEqual(['-', 'find-skills'])
  await ui.unmount()
})

test('keeps each dropdown within 64 options, the recently used first', async ($, on) => {
  const many = Array.from({ length: 80 }, (_, index) => ({
    name: `cmd-${String(index).padStart(2, '0')}`,
    description: '',
    source: 'builtin',
  }))
  world(on, { commands: many, stored: { ...AGENTS, used: { 'cmd-79': 2, simplify: 1 } } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const options = values((await ui.find({ type: 'Select', key: 'command' }))!.props)

  expect(options).toHaveLength(64)
  expect(options.slice(0, 4)).toEqual(['-', 'cmd-79', 'simplify', 'cmd-00'])
  await ui.unmount()
})

test('adds an agent type the engine offers to the agent dropdown', async ($, on) => {
  world(on, { stored: {} })
  await start($)
  await $.agent.offer({
    agent: 'pr-review',
    description: 'Reviews a pull request',
    source: 'userSettings',
    provider: { plugin: 'engine', tier: 'core' },
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(values((await ui.find({ type: 'Select', key: 'agent' }))!.props)).toEqual(['-', 'pr-review'])
  expect(values((await ui.find({ type: 'Select', key: 'source' }))!.props)).toContain('User')
  await ui.unmount()
})

test('Insert puts the skill and the agent before the draft', async ($, on) => {
  const { filled } = world(on, { draft: 'check the auth module' })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.select({ key: 'agent', value: 'Explore' })
  await ui.select({ key: 'skill', value: 'auto:fix' })
  await ui.press({ key: 'insert' })

  expect(filled).toEqual(['/auto:fix @agent-Explore check the auth module'])
  await ui.unmount()
})

test('Insert with a command puts the command alone into the prompt', async ($, on) => {
  const { filled } = world(on, { draft: 'anything' })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.select({ key: 'command', value: 'compact' })
  await ui.press({ key: 'insert' })

  expect(filled).toEqual(['/compact '])
  await ui.unmount()
})

test('Run with a command runs it and clears the pick', async ($, on) => {
  const { ran } = world(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.select({ key: 'command', value: 'compact' })
  await ui.press({ key: 'run' })

  expect(ran).toEqual([{ command: 'compact', args: '' }])
  expect((await ui.find({ type: 'Select', key: 'command' }))?.props.value).toBe('-')
  await ui.unmount()
})

test('Run with an agent starts it on the draft, with the skill named', async ($, on) => {
  const { spawned, filled } = world(on, { draft: 'check the auth module' })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.select({ key: 'agent', value: 'Explore' })
  await ui.select({ key: 'skill', value: 'find-skills' })
  await ui.press({ key: 'run' })

  expect(spawned).toEqual([
    { prompt: 'Use the find-skills skill. check the auth module', subagentType: 'Explore' },
  ])
  expect(filled).toEqual([''])
  await ui.unmount()
})

test('Run with a skill alone runs it with the draft as its arguments', async ($, on) => {
  const { ran, spawned } = world(on, { draft: 'issue 87' })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.select({ key: 'skill', value: 'auto:fix' })
  await ui.press({ key: 'run' })

  expect(ran).toEqual([{ command: 'auto:fix', args: 'issue 87' }])
  expect(spawned).toEqual([])
  await ui.unmount()
})

test('Run with an agent and no draft starts nothing', async ($, on) => {
  const { spawned } = world(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.select({ key: 'agent', value: 'Plan' })
  await ui.press({ key: 'run' })

  expect(spawned).toEqual([])
  await ui.unmount()
})

test('draws commands an earlier version stored without a source', async ($, on) => {
  world(on)
  on('state.get', ($, e, next) =>
    e.key === 'commands'
      ? { value: { value: [{ name: 'compact', description: 'Compact the conversation' }], version: 1 } }
      : next(e),
  )
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(values((await ui.find({ type: 'Select', key: 'source' }))!.props)).toEqual(['*'])
  expect(values((await ui.find({ type: 'Select', key: 'command' }))!.props)).toEqual(['-', 'compact'])
  await ui.unmount()
})

test('stays out of the way of a survey and of the mobile app', async ($, on) => {
  world(on)
  await start($)
  const survey = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
  expect(await survey.findAll({ type: 'Select' })).toEqual([])
  await survey.unmount()

  const mobile = await $.ui.mount({ ...BAND, surface: 'mobile' })
  expect(await mobile.findAll({ type: 'Select' })).toEqual([])
  expect(await mobile.find({ type: 'Text', text: 'below' })).toBeDefined()
  await mobile.unmount()
})
