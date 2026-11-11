import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import type { Board, Task } from '../types'

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-11-10T10:00:00Z')
const DAY = 24 * 60 * 60_000
const ROOT = '/work/claude-code-mods'
const PROJECT = `board:project:${ROOT}`
const SENT = { wait: false, origin: { kind: 'composer' } } as const
const TYPED = {
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const
const BAND = {
  plugin: 'task-board',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const
const PANE = {
  plugin: 'task-board',
  component: 'Pane',
  requestId: 'task-board',
  props: {
    title: 'Task board',
    isFocused: true,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const task = (number: number, fields: Partial<Task> = {}): Task => ({
  number,
  title: `Task ${number}`,
  details: '',
  status: 'todo',
  priority: 'none',
  createdAt: NOW - number * DAY,
  updatedAt: NOW - number * DAY,
  ...fields,
})

const boardOf = (...tasks: Task[]): Board => ({
  next: Math.max(0, ...tasks.map(one => one.number)) + 1,
  tasks,
})

type World = { stored?: Map<string, unknown>; isPaneUp?: boolean }

const world = (on: On, options: World = {}) => {
  const stored = options.stored ?? new Map<string, unknown>()
  const filled: string[] = []
  const submitted: { text: string; context?: readonly string[] }[] = []
  const toasts: string[] = []
  const opened: string[] = []
  const closed: string[] = []
  mock.clock(on, { now: NOW })

  // A Map stands for the store file every session shares.
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({
    value: options.isPaneUp
      ? [{ id: 'task-board', title: 'Task board', isShown: true, isFocused: false, isPlaced: true }]
      : [],
  }))
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, context: e.context })

    return { text: e.text }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>below</Text>
  })

  return { stored, filled, submitted, toasts, opened, closed }
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })

const boardIn = (stored: Map<string, unknown>, key = PROJECT) => (stored.get(key) ?? { next: 1, tasks: [] }) as Board

const labelsOf = (props: Record<string, unknown>) => (props.options as { label?: string }[]).map(one => one.label)

test('the row creates a task with a project key while Claude works and clears the field', async ($, on) => {
  const { stored, toasts } = world(on)
  await start($)

  for (const [index, surface] of SURFACES.entries()) {
    const title = `Fix flaky cache test ${index + 1}`
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
    await ui.input({ key: 'capture', text: title, kind: 'change' })
    await ui.input({ key: 'capture', text: title })

    expect(boardIn(stored).next).toBe(index + 2)
    expect(boardIn(stored).tasks[index]).toMatchObject({ number: index + 1, title, status: 'todo', details: '' })
    expect((await ui.find({ type: 'Input', key: 'capture' }))?.props.value).toBe('')
    expect(toasts).toContain(`Created CCM-${index + 1} in Todo`)

    const open = await ui.find({ type: 'Select', key: 'open' })
    expect(open?.props.label).toBe('Task')
    expect(labelsOf(open!.props)).toContain(`CCM-${index + 1} ${title}`)
    await ui.unmount()
  }
})

test('a prefix files an idea or a snippet, and an empty title creates nothing', async ($, on) => {
  const { stored } = world(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.input({ key: 'capture', text: 'idea: Weekly digest of expensive prompts' })
  await ui.input({ key: 'capture', text: 'Stash:  claude plugin validate .' })
  await ui.input({ key: 'capture', text: 'snippet: Review this PR against CLAUDE.md' })
  await ui.input({ key: 'capture', text: 'idea:   ' })

  expect(boardIn(stored).tasks.map(one => [one.number, one.status, one.title])).toEqual([
    [1, 'idea', 'Weekly digest of expensive prompts'],
    [2, 'snippet', 'claude plugin validate .'],
    [3, 'snippet', 'Review this PR against CLAUDE.md'],
  ])
  expect(labelsOf((await ui.find({ type: 'Select', key: 'open' }))!.props)).toEqual([
    '–',
    'CCM-1 Weekly digest of expensive prompts · idea',
    'claude plugin validate . · snippet',
    'Review this PR against CLAUDE.md · snippet',
  ])
  await ui.unmount()
})

test('the row has Insert and Board, and Insert puts in the key, title and details', async ($, on) => {
  const stored = new Map<string, unknown>([
    [PROJECT, boardOf(task(4, { title: 'Fix flaky cache test', details: 'Fails on Windows only.' }))],
  ])
  const { filled, toasts } = world(on, { stored })
  await start($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.findAll({ type: 'Button' })).map(one => [one.key, one.text])).toEqual([
      ['insert', 'Insert'],
      ['pane', 'Board'],
    ])
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'insert' })
  expect(toasts).toContain('Pick a task first.')

  await ui.select({ key: 'open', value: '4' })
  await ui.press({ key: 'insert' })
  expect(filled).toEqual(['CCM-4 Fix flaky cache test\n\nFails on Windows only.'])
  expect(boardIn(stored).tasks[0]?.status).toBe('todo')
  await ui.unmount()
})

test('a snippet goes in as its text', async ($, on) => {
  const stored = new Map<string, unknown>([
    [PROJECT, boardOf(task(1, { status: 'snippet', title: 'Review', details: 'Review this PR against CLAUDE.md' }))],
  ])
  const { filled } = world(on, { stored })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.select({ key: 'open', value: '1' })
  await ui.press({ key: 'insert' })

  expect(filled).toEqual(['Review this PR against CLAUDE.md'])
  await ui.unmount()
})

test('sending a prompt that names a task tells Claude what the task is', async ($, on) => {
  const stored = new Map<string, unknown>([
    [
      PROJECT,
      boardOf(
        task(4, { title: 'Fix flaky cache test', details: 'Fails on Windows only.', priority: 'high' }),
        task(5, { title: 'Bare one', status: 'doing' }),
        task(6, { status: 'snippet' }),
      ),
    ],
    ['board:global', boardOf(task(2, { title: 'Learn the hook API', details: 'Read reference.md.' }))],
  ])
  const { submitted, toasts } = world(on, { stored })
  await start($)

  await $.prompt.submit({ text: 'Work on CCM-4, then G-2, CCM-4 again, CCM-5 and CCM-6. UTF-8 is no task.', ...SENT })

  const origin = "is a task on the user's task board (the task-board mod of Claude Code, kept outside the repository)."
  expect(submitted[0]?.context).toEqual([
    `CCM-4 ${origin}\nTitle: Fix flaky cache test\nStatus: Todo\nPriority: High\nDetails:\nFails on Windows only.`,
    `CCM-5 ${origin}\nTitle: Bare one\nStatus: In progress\nPriority: No priority\nDetails: none written yet.`,
    `G-2 ${origin}\nTitle: Learn the hook API\nStatus: Todo\nPriority: No priority\nDetails:\nRead reference.md.`,
  ])
  expect(toasts).toContain('Attached CCM-4, CCM-5, G-2 for Claude')

  await $.prompt.submit({ text: 'Nothing to attach here.', ...SENT })
  expect(submitted[1]?.context).toBeUndefined()

  await $.prompt.submit({ text: 'CCM-4 Fix flaky cache test\n\nFails on Windows only.', ...SENT })
  expect(submitted[2]?.context).toEqual([
    `CCM-4 ${origin}\nTitle: Fix flaky cache test\nStatus: Todo\nPriority: High\nDetails: as written in the prompt.`,
  ])
})

test('the board puts tasks in four lanes by priority, and the arrows move them', async ($, on) => {
  const stored = new Map<string, unknown>([
    [
      PROJECT,
      boardOf(
        task(1, { status: 'idea', title: 'Mod that parks thoughts' }),
        task(2, { title: 'Low one', priority: 'low' }),
        task(3, { title: 'Urgent one', priority: 'urgent', details: 'Steps' }),
        task(4, { status: 'doing', title: 'Running one' }),
        ...[5, 6, 7, 8, 9, 10].map(number => task(number, { status: 'done' })),
        task(11, { status: 'snippet', title: 'A snippet' }),
      ),
    ],
  ])
  world(on, { stored })
  await start($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Box', key: 'lane-todo' }))?.props.width).toBe(28)
    expect(await ui.find({ type: 'Text', text: 'In progress' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Urgent' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'CCM-3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '≡ 3d' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+1 older' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'A snippet' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'left-1' })).toBeUndefined()

    const titles = (await ui.findAll({ type: 'Text', text: /^(Low|Urgent|Running) one$/ })).map(one => one.text)
    expect(titles).toEqual(['Urgent one', 'Low one', 'Running one'])
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'right-1' })
  expect(boardIn(stored).tasks.find(one => one.number === 1)?.status).toBe('todo')
  await ui.press({ key: 'left-4' })
  expect(boardIn(stored).tasks.find(one => one.number === 4)?.status).toBe('todo')
  await ui.unmount()
})

test('a narrow pane stacks the lanes', async ($, on) => {
  world(on, { stored: new Map<string, unknown>([[PROJECT, boardOf(task(1))]]) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 60 } })

  expect((await ui.find({ type: 'Box', key: 'lane-todo' }))?.props.width).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Task 1' })).toBeDefined()
  await ui.unmount()
})

test('a task opens for editing, keeps changes on Back and deletes only on a second press', async ($, on) => {
  const stored = new Map<string, unknown>([[PROJECT, boardOf(task(3, { title: 'Fix flaky cache test' }))]])
  const { filled } = world(on, { stored })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'open-3' })
  expect(await ui.find({ type: 'Text', text: 'CCM-3' })).toBeDefined()
  expect((await ui.find({ type: 'Input', key: 'title' }))?.props.value).toBe('Fix flaky cache test')

  await ui.input({ key: 'title', text: 'Fix the flaky cache test', kind: 'change' })
  await ui.input({ key: 'details', text: 'Fails on Windows only.', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /Unsaved changes/ })).toBeDefined()

  await ui.select({ key: 'priority', value: 'high' })
  await ui.press({ key: 'insert-task' })
  expect(filled).toEqual(['CCM-3 Fix flaky cache test'])

  await ui.press({ key: 'back' })
  expect(boardIn(stored).tasks[0]).toMatchObject({
    title: 'Fix the flaky cache test',
    details: 'Fails on Windows only.',
    priority: 'high',
    updatedAt: NOW,
  })
  expect(await ui.find({ type: 'Text', text: 'High' })).toBeDefined()

  await ui.press({ key: 'open-3' })
  await ui.press({ key: 'insert-task' })
  expect(filled[1]).toBe('CCM-3 Fix the flaky cache test\n\nFails on Windows only.')

  await ui.press({ key: 'delete' })
  expect(boardIn(stored).tasks.length).toBe(1)
  expect(await ui.find({ type: 'Button', key: 'delete' })).toMatchObject({ props: { label: 'Press again to delete' } })
  await ui.press({ key: 'delete' })
  expect(boardIn(stored).tasks).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Board' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'tab-board' })).toBeDefined()
  await ui.unmount()
})

test('an empty title is not saved', async ($, on) => {
  const stored = new Map<string, unknown>([[PROJECT, boardOf(task(1, { title: 'Keep me' }))]])
  const { toasts } = world(on, { stored })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'open-1' })
  await ui.input({ key: 'title', text: '  ', kind: 'change' })
  await ui.press({ key: 'back' })

  expect(toasts).toContain('A task needs a title.')
  expect(boardIn(stored).tasks[0]?.title).toBe('Keep me')
  expect(await ui.find({ type: 'Input', key: 'title' })).toBeDefined()
  await ui.unmount()
})

test('the Snippets tab lists snippets and creates one from a bare line', async ($, on) => {
  const { stored, filled } = world(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'tab-snippets' })
  expect(await ui.find({ type: 'Text', text: /No snippets yet/ })).toBeDefined()
  await ui.input({ key: 'new', text: 'Summarize the diff' })

  expect(boardIn(stored).tasks[0]).toMatchObject({ status: 'snippet', title: 'Summarize the diff' })
  await ui.press({ key: 'use-1' })
  expect(filled).toEqual(['Summarize the diff'])
  await ui.unmount()
})

test('each project keeps its own board, and the global scope is remembered', async ($, on) => {
  const stored = new Map<string, unknown>([
    [PROJECT, boardOf(task(1, { title: 'Only here' }))],
    ['board:project:/work/other', boardOf(task(1, { title: 'Only there' }))],
    ['board:global', boardOf(task(1, { title: 'Everywhere' }))],
  ])
  world(on, { stored })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: 'Only here' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Only there' })).toBeUndefined()
  expect(labelsOf((await ui.find({ type: 'Select', key: 'scope' }))!.props)).toEqual([
    'claude-code-mods · CCM',
    'Global · G',
  ])

  await ui.select({ key: 'scope', value: 'global' })
  expect(await ui.find({ type: 'Text', text: 'Everywhere' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'G-1' })).toBeDefined()
  expect(stored.get('scope')).toBe('global')
  await ui.unmount()
})

test('a session started later in the global scope opens on it', async ($, on) => {
  world(on, { stored: new Map<string, unknown>([['scope', 'global'], ['board:global', boardOf(task(1, { title: 'Everywhere' }))]]) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Select', key: 'scope' }))?.props.value).toBe('global')
  expect(await ui.find({ type: 'Text', text: 'Everywhere' })).toBeDefined()
  await ui.unmount()
})

test('Tasks opens the pane while it is closed', async ($, on) => {
  const { opened, closed } = world(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.press({ key: 'pane' })
  expect(opened).toEqual(['task-board'])
  expect(closed).toEqual([])
  await ui.unmount()
})

test('a press while the pane is up closes it, and /task-board leaves an open pane as it is', async ($, on) => {
  const { opened, closed } = world(on, { isPaneUp: true })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.press({ key: 'pane' })
  expect(closed).toEqual(['task-board'])

  expect(await $.command.run({ command: 'task-board', ...TYPED })).toMatchObject({ text: 'Opened the task board.' })
  expect(opened).toEqual([])
  await ui.unmount()
})

test('the row yields to a survey and to mobile', async ($, on) => {
  world(on)
  await start($)

  const survey = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
  expect(await survey.find({ type: 'Input', key: 'capture' })).toBeUndefined()
  await survey.unmount()

  const mobile = await $.ui.mount({ ...BAND, surface: 'mobile' })
  expect(await mobile.find({ type: 'Input', key: 'capture' })).toBeUndefined()
  await mobile.unmount()
})

const TOOL = 'mcp__task-board__tasks'

const toolWorld = (on: On, stored: Map<string, unknown>) => {
  const registered: string[] = []
  const found = world(on, { stored })
  on('tool.register', ($, e) => {
    registered.push(e.name)

    return { value: { tool: `mcp__task-board__${e.name}` } }
  })

  return { ...found, registered }
}

const call = async ($: Engine, input: Record<string, unknown>) =>
  (await $.tool.call({ tool: TOOL, ...input } as Parameters<Engine['tool']['call']>[0])) as { result?: string; deny?: string }

test('without the option Claude gets no tool and the attached task names none', async ($, on) => {
  const stored = new Map<string, unknown>([[PROJECT, boardOf(task(1, { title: 'Only one' }))]])
  const { registered, submitted } = toolWorld(on, stored)
  await start($)
  await $.prompt.submit({ text: 'Do CCM-1', ...SENT })

  expect(registered).toEqual([])
  expect(submitted[0]?.context?.[0]).not.toContain(TOOL)
})

test('with the option Claude lists, reads, creates and updates tasks', { options: { claudeTool: true } }, async ($, on) => {
  const stored = new Map<string, unknown>([
    [
      PROJECT,
      boardOf(
        task(1, { title: 'Low one', priority: 'low' }),
        task(2, { title: 'Urgent one', priority: 'urgent', details: 'Steps' }),
        task(3, { title: 'Finished', status: 'done' }),
      ),
    ],
    ['board:global', boardOf(task(1, { title: 'Everywhere', status: 'idea' }))],
  ])
  const { registered, submitted, toasts } = toolWorld(on, stored)
  await start($)
  expect(registered).toEqual(['tasks'])

  await $.prompt.submit({ text: 'Do CCM-1', ...SENT })
  expect(submitted[0]?.context?.[0]).toContain(`You can read and change this board with the ${TOOL} tool.`)

  expect((await call($, { action: 'list' })).result).toBe(
    [
      'Project board (claude-code-mods): 2 open',
      'CCM-2 [Todo, Urgent] Urgent one (has details)',
      'CCM-1 [Todo, Low] Low one',
      'Global board: 1 open',
      'G-1 [Ideas] Everywhere',
    ].join('\n'),
  )
  expect((await call($, { action: 'list', scope: 'project', status: 'done' })).result).toBe(
    'Project board (claude-code-mods): 1 Done\nCCM-3 [Done] Finished',
  )
  expect((await call($, { action: 'get', key: 'ccm-2' })).result).toBe(
    'CCM-2\nTitle: Urgent one\nStatus: Todo\nPriority: Urgent\nDetails:\nSteps',
  )

  const created = await call($, { action: 'create', title: 'Write the release notes', priority: 'high' })
  expect(created.result).toContain('Created CCM-4.')
  expect(boardIn(stored).tasks[3]).toMatchObject({ number: 4, status: 'todo', priority: 'high' })

  const updated = await call($, { action: 'update', key: 'CCM-2', status: 'done', note: 'Fixed in the cache layer.' })
  expect(updated.result).toContain('Updated CCM-2.')
  expect(boardIn(stored).tasks[1]).toMatchObject({
    status: 'done',
    details: 'Steps\n\n2026-11-10 Claude: Fixed in the cache layer.',
    updatedAt: NOW,
  })
  expect(toasts).toEqual(expect.arrayContaining(['Claude created CCM-4', 'Claude updated CCM-2']))
})

test('the tool refuses a key, status or action it does not know', { options: { claudeTool: true } }, async ($, on) => {
  toolWorld(on, new Map<string, unknown>([[PROJECT, boardOf(task(1))]]))
  await start($)

  expect((await call($, { action: 'get', key: 'CCM-9' })).deny).toBe('There is no task CCM-9 on the project or the global board.')
  expect((await call($, { action: 'get', key: 'XYZ-1' })).deny).toContain('There is no task XYZ-1')
  expect((await call($, { action: 'update', key: 'CCM-1', status: 'closed' })).deny).toContain('status is one of')
  expect((await call($, { action: 'create' })).deny).toBe('create needs a title.')
  expect((await call($, { action: 'delete' })).deny).toBe('action is one of list, get, create, update.')
})

test('a task Claude moves shows on the open board', { options: { claudeTool: true } }, async ($, on) => {
  const stored = new Map<string, unknown>([[PROJECT, boardOf(task(1, { title: 'Moving one' }))]])
  toolWorld(on, stored)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Button', key: 'left-1' })).toBeDefined()
  await call($, { action: 'update', key: 'CCM-1', status: 'idea' })
  expect(await ui.find({ type: 'Button', key: 'left-1' })).toBeUndefined()
  await ui.unmount()
})
