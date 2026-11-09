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
const posix = (path: string) => path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')

const DIRS: Record<string, string[]> = {
  '/home/.claude/skills': ['find-skills'],
  '/plugins/auto/skills': ['fix', 'setup'],
  '/work/.claude/skills': ['release'],
  '/work/.claude/commands': ['deploy.md', 'db', 'notes.txt'],
  '/work/.claude/commands/db': ['migrate.md'],
}

const FILES: Record<string, string> = {
  '/home/.claude/plugins/installed_plugins.json': JSON.stringify({
    plugins: { 'auto@thor-skills': [{ installPath: '/plugins/auto' }] },
  }),
  '/home/.claude/skills/find-skills/SKILL.md': '---\nname: find-skills\ndescription: Discover skills\n---\n# Find',
  '/plugins/auto/skills/setup/SKILL.md': '---\r\nname: setup\r\ndisable-model-invocation: true\r\n---\r\n# Setup',
}

const COMMANDS = [
  { name: 'simplify', description: 'Review changed code', source: 'builtin' },
  { name: 'compact', description: 'Compact the conversation', source: 'builtin' },
  { name: 'find-skills', description: 'Discover agent skills', source: 'user' },
  { name: 'auto:fix', description: 'Fix a bug', source: 'plugin', plugin: 'auto' },
  { name: 'auto:setup', description: 'Set up auto', source: 'plugin', plugin: 'auto' },
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
  on('classic.SessionStart', () => ({}))
  on('turn.complete', () => ({}))
  on('command.list', () => ({ value: [...COMMANDS, ...(options.commands ?? [])] }))
  on('fs.list', ($, e) => {
    const names = DIRS[posix(e.path)]

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
    const file = FILES[posix(e.path)]

    return file === undefined ? { deny: 'ENOENT' } : { value: file }
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

type Option = { value: string; label?: string }

const options = (props: Record<string, unknown>) => props.options as Option[]
const values = (props: Record<string, unknown>) => options(props).map(one => one.value)

const mounted = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const shown = async (key: string) => {
    const picker = await ui.find({ type: 'Select', key })

    return { options: values(picker!.props), value: picker!.props.value as string }
  }

  return { ui, shown }
}

test('puts Source, the slash and the agent dropdown and both buttons in one row under the rows beneath', async ($, on) => {
  world(on)
  await start($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
    expect((await ui.findAll({ type: 'Select' })).map(one => one.key)).toEqual(['source', 'slash', 'agent'])
    expect((await ui.findAll({ type: 'Button' })).map(one => one.key)).toEqual(['insert', 'run'])
    await ui.unmount()
  }
})

test('lists skills and commands in one slash dropdown, each labelled with its kind', async ($, on) => {
  world(on)
  await start($)
  const { ui, shown } = await mounted($)
  const slash = options((await ui.find({ type: 'Select', key: 'slash' }))!.props)

  expect(slash.map(one => one.value)).toEqual([
    '-',
    'auto:fix',
    'auto:setup',
    'compact',
    'find-skills',
    'review-pr',
    'simplify',
  ])
  expect(slash.find(one => one.value === 'auto:fix')?.label).toBe('auto:fix · skill')
  expect(slash.find(one => one.value === 'compact')?.label).toBe('compact · command')
  expect((await shown('agent')).options).toEqual(['-', 'Explore', 'Plan'])
  await ui.unmount()
})

test('narrows both dropdowns to the source picked, and drops only the picks from another', async ($, on) => {
  world(on)
  await start($)
  const { ui, shown } = await mounted($)

  expect((await shown('source')).options).toEqual(['*', 'auto', 'Built-in', 'gh-tools', 'User'])
  await ui.select({ key: 'agent', value: 'Explore' })
  await ui.select({ key: 'slash', value: 'auto:fix' })
  await ui.select({ key: 'source', value: 'Built-in' })

  expect(await shown('agent')).toEqual({ options: ['-', 'Explore', 'Plan'], value: 'Explore' })
  expect(await shown('slash')).toEqual({ options: ['-', 'compact', 'simplify'], value: '-' })

  await ui.select({ key: 'source', value: 'gh-tools' })
  expect(await shown('agent')).toEqual({ options: ['-'], value: '-' })
  expect(await shown('slash')).toEqual({ options: ['-', 'review-pr'], value: '-' })
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
  const { ui, shown } = await mounted($)
  await ui.select({ key: 'source', value: 'Project' })

  expect((await shown('slash')).options).toEqual(['-', 'deploy', 'migrate', 'release'])

  await ui.select({ key: 'source', value: 'User' })
  expect((await shown('slash')).options).toEqual(['-', 'find-skills'])
  await ui.unmount()
})

test('keeps the slash dropdown within 64 options, the recently used first', async ($, on) => {
  const many = Array.from({ length: 80 }, (_, index) => ({
    name: `cmd-${String(index).padStart(2, '0')}`,
    description: '',
    source: 'builtin',
  }))
  world(on, { commands: many, stored: { ...AGENTS, used: { 'cmd-79': 2, 'auto:fix': 1 } } })
  await start($)
  const { ui, shown } = await mounted($)
  const slash = (await shown('slash')).options

  expect(slash).toHaveLength(64)
  expect(slash.slice(0, 4)).toEqual(['-', 'cmd-79', 'auto:fix', 'auto:setup'])
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
  const { ui, shown } = await mounted($)

  expect((await shown('agent')).options).toEqual(['-', 'pr-review'])
  expect((await shown('source')).options).toContain('User')
  await ui.unmount()
})

test('a skill keeps the agent, while a command or a manual-only skill clears it', async ($, on) => {
  world(on)
  await start($)
  const { ui, shown } = await mounted($)
  const picks = async () => [(await shown('slash')).value, (await shown('agent')).value]

  await ui.select({ key: 'agent', value: 'Explore' })
  await ui.select({ key: 'slash', value: 'find-skills' })
  expect(await picks()).toEqual(['find-skills', 'Explore'])

  await ui.select({ key: 'slash', value: 'compact' })
  expect(await picks()).toEqual(['compact', '-'])

  await ui.select({ key: 'agent', value: 'Plan' })
  expect(await picks()).toEqual(['-', 'Plan'])

  await ui.select({ key: 'slash', value: 'auto:setup' })
  expect(await picks()).toEqual(['auto:setup', '-'])
  await ui.unmount()
})

test('Insert puts the skill and the agent before the draft', async ($, on) => {
  const { filled } = world(on, { draft: 'check the auth module' })
  await start($)
  const { ui } = await mounted($)
  await ui.select({ key: 'agent', value: 'Explore' })
  await ui.select({ key: 'slash', value: 'auto:fix' })
  await ui.press({ key: 'insert' })

  expect(filled).toEqual(['/auto:fix @agent-Explore check the auth module'])
  await ui.unmount()
})

test('Insert with a command puts the command before the draft and keeps it', async ($, on) => {
  const { filled } = world(on, { draft: 'focus on the API' })
  await start($)
  const { ui } = await mounted($)
  await ui.select({ key: 'slash', value: 'compact' })
  await ui.press({ key: 'insert' })

  expect(filled).toEqual(['/compact focus on the API'])
  await ui.unmount()
})

test('Run with a command runs it and clears the pick', async ($, on) => {
  const { ran, spawned } = world(on, { draft: 'check the auth module' })
  await start($)
  const { ui, shown } = await mounted($)
  await ui.select({ key: 'slash', value: 'compact' })
  await ui.press({ key: 'run' })

  expect(ran).toEqual([{ command: 'compact', args: '' }])
  expect(spawned).toEqual([])
  expect((await shown('slash')).value).toBe('-')
  await ui.unmount()
})

test('Run with an agent starts it on the draft, with the skill named', async ($, on) => {
  const { spawned, filled } = world(on, { draft: 'check the auth module' })
  await start($)
  const { ui } = await mounted($)
  await ui.select({ key: 'agent', value: 'Explore' })
  await ui.select({ key: 'slash', value: 'find-skills' })
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
  const { ui } = await mounted($)
  await ui.select({ key: 'slash', value: 'auto:fix' })
  await ui.press({ key: 'run' })

  expect(ran).toEqual([{ command: 'auto:fix', args: 'issue 87' }])
  expect(spawned).toEqual([])
  await ui.unmount()
})

test('Run with an agent and no draft starts nothing', async ($, on) => {
  const { spawned } = world(on)
  await start($)
  const { ui } = await mounted($)
  await ui.select({ key: 'agent', value: 'Plan' })
  await ui.press({ key: 'run' })

  expect(spawned).toEqual([])
  await ui.unmount()
})

test('fills both dropdowns again after a /clear', async ($, on) => {
  world(on)
  await $.classic.SessionStart({ source: 'clear' })
  const { ui, shown } = await mounted($)

  expect((await shown('agent')).options).toEqual(['-', 'Explore', 'Plan'])
  expect((await shown('slash')).options).toContain('find-skills')
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
