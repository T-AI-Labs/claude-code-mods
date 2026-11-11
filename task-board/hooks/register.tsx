import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Priority, Scope, Status, Tab, Task } from '../types'

const PANE = 'task-board'
const COMMAND = 'task-board'
const SCOPE_KEY = 'scope'
const GLOBAL_PREFIX = 'G'
const NONE = '-'
// AbovePrompt refuses a Select with more than 64 options; one of them is the empty pick.
const MAX_CHOICES = 63
// The desktop's native Select and Button are taller than one text row and spill onto the row above.
const DESKTOP_ROWS = 2
// Four lanes of at least 20 cells and their gaps; a narrower pane stacks them.
const BOARD_COLUMNS = 88
const LANE_GAP = 2
const DONE_SHOWN = 5
const DETAILS_ROWS = 8
const LABEL_LENGTH = 48
const DAY = 24 * 60 * 60_000
const PREFIX = /^(todo|idea|snippet|stash):\s*/i
const PLACEHOLDER = 'New task, or idea: … or snippet: …'
// With the row's gap on either side, four cells between the field and Task and between Insert and Board.
const GROUP_SPACE = 2
const REFERENCE = /\b([A-Z][A-Z0-9]{0,3})-(\d+)\b/g

const LANES = [
  { status: 'idea', title: 'Ideas' },
  { status: 'todo', title: 'Todo' },
  { status: 'doing', title: 'In progress' },
  { status: 'done', title: 'Done' },
] as const

const STATUSES: readonly { value: Status; label: string }[] = [
  ...LANES.map(({ status, title }) => ({ value: status, label: title })),
  { value: 'snippet', label: 'Snippet' },
]

const PRIORITIES: readonly { value: Priority; label: string; color?: string; isDim?: boolean }[] = [
  { value: 'urgent', label: 'Urgent', color: 'error' },
  { value: 'high', label: 'High', color: 'warning' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low', isDim: true },
  { value: 'none', label: 'No priority', isDim: true },
]

const EMPTY: Board = { next: 1, tasks: [] }

const board = atom({ plugin: 'task-board', key: 'board' } as const, EMPTY, { shape: 'board-1' })
const scope = atom({ plugin: 'task-board', key: 'scope' } as const, 'project')
const tab = atom({ plugin: 'task-board', key: 'tab' } as const, 'board')
const picked = atom({ plugin: 'task-board', key: 'picked' } as const, 0)
const opened = atom({ plugin: 'task-board', key: 'opened' } as const, 0)
const isDeleting = atom({ plugin: 'task-board', key: 'isDeleting' } as const, false)
const rowDraft = atom({ plugin: 'task-board', key: 'rowDraft' } as const, '')
const newDraft = atom({ plugin: 'task-board', key: 'newDraft' } as const, '')
const titleDraft = atom({ plugin: 'task-board', key: 'titleDraft' } as const, '')
const detailsDraft = atom({ plugin: 'task-board', key: 'detailsDraft' } as const, '')

const shorten = (text: string) => (text.length > LABEL_LENGTH ? `${text.slice(0, LABEL_LENGTH - 1)}…` : text)

const folderName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root

// claude-code-mods becomes CCM, a one-word folder its first three letters.
function projectPrefix(root: string) {
  const words = folderName(root).split(/[^A-Za-z0-9]+/).filter(word => /^[A-Za-z]/.test(word))
  const prefix = words.length > 1 ? words.map(word => word[0]).join('') : (words[0] ?? '').slice(0, 3)

  return prefix === '' ? 'BL' : prefix.slice(0, 4).toUpperCase()
}

const prefixOf = async ($: EngineInterface, where: Scope) =>
  where === 'global' ? GLOBAL_PREFIX : projectPrefix(await $.session.root())

const keyOf = (prefix: string, task: Task) => `${prefix}-${task.number}`

const isTask = (task: Task) => task.status !== 'snippet'

const rankOf = (priority: Priority) => PRIORITIES.findIndex(one => one.value === priority)

const priorityOf = (priority: Priority) => PRIORITIES.find(one => one.value === priority) ?? PRIORITIES[4]!

const laneTitle = (status: Status) => STATUSES.find(one => one.value === status)?.label ?? status

const byPriority = (a: Task, b: Task) => rankOf(a.priority) - rankOf(b.priority) || a.createdAt - b.createdAt

const byRecent = (a: Task, b: Task) => b.updatedAt - a.updatedAt

function ageOf(ms: number) {
  const days = Math.floor(ms / DAY)

  if (days < 1) {
    return 'today'
  }

  if (days < 7) {
    return `${days}d`
  }

  return days < 35 ? `${Math.floor(days / 7)}w` : `${Math.floor(days / 30)}mo`
}

function parse(value: string): { status: Status; title: string } {
  const trimmed = value.trim()
  const match = PREFIX.exec(trimmed)
  const word = (match?.[1] ?? 'todo').toLowerCase()
  const status: Status = word === 'idea' ? 'idea' : word === 'todo' ? 'todo' : 'snippet'

  return { status, title: match === null ? trimmed : trimmed.slice(match[0].length).trim() }
}

// Each scope has a store key of its own, so sessions in other projects never overwrite this one's board.
const storeKeyOf = async ($: EngineInterface, where: Scope) =>
  where === 'global' ? 'board:global' : `board:project:${await $.session.root()}`

const storedIn = async ($: EngineInterface, where: Scope) =>
  ((await $.store.get(await storeKeyOf($, where))) ?? EMPTY) as Board

async function load($: EngineInterface) {
  const stored = await storedIn($, await read($, scope))
  await update($, board, () => stored)
}

// Reads the store again before each write: another session may have changed the board since this one loaded it.
async function changeIn($: EngineInterface, where: Scope, edit: (current: Board) => Board) {
  const edited = edit(await storedIn($, where))
  await $.store.set(await storeKeyOf($, where), edited)

  if ((await read($, scope)) === where) {
    await update($, board, () => edited)
  }

  return edited
}

const change = async ($: EngineInterface, edit: (current: Board) => Board) => changeIn($, await read($, scope), edit)

const editTask = (number: number, now: number, edit: (task: Task) => Task) => (current: Board) => ({
  ...current,
  tasks: current.tasks.map(one => (one.number === number ? { ...edit(one), updatedAt: now } : one)),
})

const changeTask = async ($: EngineInterface, number: number, edit: (task: Task) => Task) =>
  change($, editTask(number, await $.clock.now(), edit))

const taskOf = async ($: EngineInterface, number: number) =>
  (await read($, board)).tasks.find(one => one.number === number)

async function restoreScope($: EngineInterface) {
  const stored = await $.store.get(SCOPE_KEY)

  if (stored === 'project' || stored === 'global') {
    await update($, scope, () => stored)
  }
}

async function reload($: EngineInterface) {
  await restoreScope($)
  await load($)
}

async function pickScope($: EngineInterface, value: string) {
  const chosen: Scope = value === 'global' ? 'global' : 'project'
  await update($, scope, () => chosen)
  await update($, picked, () => 0)
  await update($, opened, () => 0)
  await $.store.set(SCOPE_KEY, chosen)
  await load($)
}

type Fields = Pick<Task, 'title' | 'details' | 'status' | 'priority'>

async function addTask($: EngineInterface, where: Scope, fields: Fields) {
  const now = await $.clock.now()
  const edited = await changeIn($, where, current => ({
    next: current.next + 1,
    tasks: [...current.tasks, { number: current.next, ...fields, createdAt: now, updatedAt: now }],
  }))

  return edited.tasks[edited.tasks.length - 1]!
}

async function create($: EngineInterface, value: string) {
  const { status, title } = parse(value)

  if (title === '') {
    return false
  }

  const where = await read($, scope)
  const made = await addTask($, where, { title, details: '', status, priority: 'none' })
  const prefix = await prefixOf($, where)
  $.ui.toast(status === 'snippet' ? `Saved the snippet ${title}` : `Created ${keyOf(prefix, made)} in ${laneTitle(status)}`)

  return true
}

async function submitRow($: EngineInterface, value: string) {
  if (await create($, value)) {
    await update($, rowDraft, () => '')
  }
}

async function submitNew($: EngineInterface, value: string) {
  if (await create($, value)) {
    await update($, newDraft, () => '')
  }
}

const referenceOf = async ($: EngineInterface, task: Task) =>
  `${keyOf(await prefixOf($, await read($, scope)), task)} ${task.title}`

const bodyOf = (task: Task) => (task.details.trim() === '' ? task.title : task.details)

// A snippet is reused as it stands; a task goes in with its key, title and details.
async function promptTextOf($: EngineInterface, task: Task) {
  if (!isTask(task)) {
    return bodyOf(task)
  }

  const reference = await referenceOf($, task)

  return task.details.trim() === '' ? reference : `${reference}\n\n${task.details.trim()}`
}

async function insert($: EngineInterface, task: Task) {
  await $.prompt.fill({ text: await promptTextOf($, task), mode: 'insert' })
}

async function withPicked($: EngineInterface, act: (task: Task) => Promise<unknown>) {
  const task = await taskOf($, await read($, picked))

  if (task === undefined) {
    $.ui.toast('Pick a task first.')

    return
  }

  await act(task)
}

async function withOpened($: EngineInterface, act: (task: Task) => Promise<unknown>) {
  const task = await taskOf($, await read($, opened))

  if (task !== undefined) {
    await act(task)
  }
}

async function move($: EngineInterface, task: Task, step: -1 | 1) {
  const at = LANES.findIndex(one => one.status === task.status)
  const lane = LANES[at + step]

  if (lane !== undefined) {
    await changeTask($, task.number, one => ({ ...one, status: lane.status }))
  }
}

async function openTask($: EngineInterface, task: Task) {
  await update($, titleDraft, () => task.title)
  await update($, detailsDraft, () => task.details)
  await update($, isDeleting, () => false)
  await update($, opened, () => task.number)
}

const isDirty = async ($: EngineInterface, task: Task) =>
  (await read($, titleDraft)).trim() !== task.title || (await read($, detailsDraft)) !== task.details

async function save($: EngineInterface) {
  const title = (await read($, titleDraft)).trim()

  if (title === '') {
    $.ui.toast('A task needs a title.')

    return false
  }

  const details = await read($, detailsDraft)
  await withOpened($, async task => {
    if (await isDirty($, task)) {
      await changeTask($, task.number, one => ({ ...one, title, details }))
    }
  })

  return true
}

async function back($: EngineInterface) {
  if (await save($)) {
    await update($, opened, () => 0)
  }
}

async function remove($: EngineInterface) {
  if (!(await read($, isDeleting))) {
    await update($, isDeleting, () => true)

    return
  }

  await withOpened($, task =>
    change($, current => ({ ...current, tasks: current.tasks.filter(one => one.number !== task.number) })),
  )
  await update($, opened, () => 0)
  await update($, isDeleting, () => false)
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Task board' })

const isPaneUp = async ($: EngineInterface) => (await $.ui.panes()).some(pane => pane.id === PANE)

// Opening a pane that is already up redraws it at its default size, so a second press closes it instead.
async function togglePane($: EngineInterface) {
  if (await isPaneUp($)) {
    await $.ui.close({ id: PANE })
  } else {
    await load($)
    await openPane($)
  }
}

const rowOrder = (task: Task) =>
  ({ doing: 0, todo: 1, idea: 2, snippet: 3, done: 4 })[task.status]

const ROW_TAGS: Record<Status, string> = { idea: ' · idea', todo: '', doing: ' · in progress', done: ' · done', snippet: ' · snippet' }

function choiceOf(prefix: string, task: Task) {
  const status = ROW_TAGS[task.status]

  return {
    value: String(task.number),
    label: isTask(task) ? `${keyOf(prefix, task)} ${shorten(task.title)}${status}` : `${shorten(task.title)}${status}`,
  }
}

// Reads the tasks a prompt names in both scopes, so a global task works from any project.
async function attached($: EngineInterface, text: string) {
  const keys = new Set([...text.matchAll(REFERENCE)].map(match => match[0]))

  if (keys.size === 0) {
    return []
  }

  const scopes = [
    { prefix: projectPrefix(await $.session.root()), board: await storedIn($, 'project') },
    { prefix: GLOBAL_PREFIX, board: await storedIn($, 'global') },
  ]
  const found: Attached[] = []

  for (const { prefix, board: one } of scopes) {
    for (const task of one.tasks) {
      const key = keyOf(prefix, task)
      const details = task.details.trim()

      if (keys.has(key) && isTask(task)) {
        found.push({ key, task, isDetailed: details !== '' && text.includes(details) })
      }
    }
  }

  return found
}

type Attached = { key: string; task: Task; isDetailed: boolean }

const detailsLine = (task: Task) =>
  task.details.trim() === '' ? 'Details: none written yet.' : `Details:\n${task.details.trim()}`

const taskLines = (task: Task, isDetailed = false) => [
  `Title: ${task.title}`,
  `Status: ${laneTitle(task.status)}`,
  `Priority: ${priorityOf(task.priority).label}`,
  isDetailed ? 'Details: as written in the prompt.' : detailsLine(task),
]

// Claude has no other view of the board, so the block says where the key comes from.
const contextOf = (hasTool: boolean) => ({ key, task, isDetailed }: Attached) =>
  [
    `${key} is a task on the user's task board (the task-board mod of Claude Code, kept outside the repository).`,
    ...taskLines(task, isDetailed),
    ...(hasTool ? [`You can read and change this board with the ${TOOL_NAME} tool.`] : []),
  ].join('\n')

const TOOL = 'tasks'
const TOOL_NAME = 'mcp__task-board__tasks'
const KEY = /^([A-Z][A-Z0-9]{0,3})-(\d+)$/
const LIST_LIMIT = 50
const ACTIONS = ['list', 'get', 'create', 'update'] as const

const TOOL_SPEC = {
  name: TOOL,
  description:
    "The user's task board in Claude Code: list its tasks, read one by key (such as CCM-12), create one, or change one's status, priority, title or details, or add a note to it. Task keys in the user's prompts come from this board.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      key: { type: 'string', description: 'The task key, for get and update.' },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: 'The board to list or create on. list reads both when left out; create uses project.',
      },
      status: {
        type: 'string',
        enum: STATUSES.map(one => one.value),
        description: 'For list, the lane to show (the open tasks when left out); for create and update, the status to set.',
      },
      priority: { type: 'string', enum: PRIORITIES.map(one => one.value) },
      title: { type: 'string' },
      details: { type: 'string', description: 'Replaces the details.' },
      note: { type: 'string', description: 'Added to the end of the details under a dated line.' },
    },
    required: ['action'],
  },
}

type BoardCall = {
  action?: string
  key?: string
  scope?: string
  status?: string
  priority?: string
  title?: string
  details?: string
  note?: string
}

const isStatus = (value: unknown): value is Status => STATUSES.some(one => one.value === value)

const isPriority = (value: unknown): value is Priority => PRIORITIES.some(one => one.value === value)

const summaryOf = (key: string, task: Task) => {
  const priority = task.priority === 'none' ? '' : `, ${priorityOf(task.priority).label}`
  const details = task.details.trim() === '' ? '' : ' (has details)'

  return `${key} [${laneTitle(task.status)}${priority}] ${task.title}${details}`
}

async function locate($: EngineInterface, key: string | undefined) {
  const match = KEY.exec((key ?? '').trim().toUpperCase())

  if (match === null) {
    return undefined
  }

  const [, prefix, digits] = match
  const where: Scope | undefined =
    prefix === GLOBAL_PREFIX ? 'global' : prefix === projectPrefix(await $.session.root()) ? 'project' : undefined
  const task =
    where === undefined ? undefined : (await storedIn($, where)).tasks.find(one => one.number === Number(digits))

  return where === undefined || task === undefined ? undefined : { key: `${prefix}-${digits}`, where, task }
}

async function listFor($: EngineInterface, call: BoardCall) {
  const root = await $.session.root()
  const scopes: { where: Scope; prefix: string; title: string }[] = [
    { where: 'project', prefix: projectPrefix(root), title: `Project board (${folderName(root)})` },
    { where: 'global', prefix: GLOBAL_PREFIX, title: 'Global board' },
  ]
  const lines: string[] = []

  for (const { where, prefix, title } of scopes.filter(one => call.scope === undefined || one.where === call.scope)) {
    const shown = (await storedIn($, where)).tasks
      .filter(one => (call.status === undefined ? one.status !== 'done' && one.status !== 'snippet' : one.status === call.status))
      .sort(byPriority)
    lines.push(`${title}: ${shown.length} ${call.status === undefined ? 'open' : laneTitle(call.status as Status)}`)
    lines.push(...shown.slice(0, LIST_LIMIT).map(one => summaryOf(keyOf(prefix, one), one)))
  }

  return lines.join('\n')
}

const withNote = (details: string, note: string, now: number) => {
  const line = `${new Date(now).toISOString().slice(0, 10)} Claude: ${note.trim()}`

  return details.trim() === '' ? line : `${details.trim()}\n\n${line}`
}

async function answer($: EngineInterface, call: BoardCall): Promise<{ result: string } | { deny: string }> {
  if (call.status !== undefined && !isStatus(call.status)) {
    return { deny: `status is one of ${STATUSES.map(one => one.value).join(', ')}.` }
  }

  if (call.priority !== undefined && !isPriority(call.priority)) {
    return { deny: `priority is one of ${PRIORITIES.map(one => one.value).join(', ')}.` }
  }

  if (call.scope !== undefined && call.scope !== 'project' && call.scope !== 'global') {
    return { deny: 'scope is project or global.' }
  }

  if (call.action === 'list') {
    return { result: await listFor($, call) }
  }

  if (call.action === 'create') {
    const title = (call.title ?? '').trim()

    if (title === '') {
      return { deny: 'create needs a title.' }
    }

    const where: Scope = call.scope === 'global' ? 'global' : 'project'
    const made = await addTask($, where, {
      title,
      details: (call.details ?? '').trim(),
      status: isStatus(call.status) ? call.status : 'todo',
      priority: isPriority(call.priority) ? call.priority : 'none',
    })
    const key = keyOf(await prefixOf($, where), made)
    $.ui.toast(`Claude created ${key}`)

    return { result: [`Created ${key}.`, ...taskLines(made)].join('\n') }
  }

  if (call.action !== 'get' && call.action !== 'update') {
    return { deny: `action is one of ${ACTIONS.join(', ')}.` }
  }

  const found = await locate($, call.key)

  if (found === undefined) {
    return { deny: `There is no task ${call.key ?? ''} on the project or the global board.` }
  }

  if (call.action === 'get') {
    return { result: [found.key, ...taskLines(found.task)].join('\n') }
  }

  const now = await $.clock.now()
  const edited = await changeIn(
    $,
    found.where,
    editTask(found.task.number, now, one => {
      const details = call.details === undefined ? one.details : call.details.trim()

      return {
        ...one,
        title: (call.title ?? '').trim() || one.title,
        details: call.note === undefined || call.note.trim() === '' ? details : withNote(details, call.note, now),
        status: isStatus(call.status) ? call.status : one.status,
        priority: isPriority(call.priority) ? call.priority : one.priority,
      }
    }),
  )
  const changed = edited.tasks.find(one => one.number === found.task.number)!
  $.ui.toast(`Claude updated ${found.key}`)

  return { result: [`Updated ${found.key}.`, ...taskLines(changed)].join('\n') }
}

export const register: Register = (on, options) => {
  const hasTool = options.claudeTool === true

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show the task board: tasks, ideas and snippets' })

    if (hasTool) {
      await $.tool.register(TOOL_SPEC)
    }

    const result = await next(e)
    await reload($)

    return result
  })

  // A /clear wipes every plugin's state after session.end and raises no session.start, only this.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      await reload($).catch(() => undefined)
    }

    return next(e)
  })

  // Another session may have changed the board meanwhile.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await load($)

    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    await load($)

    if (!(await isPaneUp($))) {
      await openPane($)
    }

    return { text: 'Opened the task board.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const found = await attached($, e.text).catch(() => [])

    if (found.length === 0) {
      return next(e)
    }

    $.ui.toast(`Attached ${found.map(one => one.key).join(', ')} for Claude`)

    return next({ ...e, context: [...(e.context ?? []), ...found.map(contextOf(hasTool))] })
  })

  if (hasTool) {
    on('tool.call', { tool: TOOL_NAME }, ($, e) => answer($, e as unknown as BoardCall))
  }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    if (e.props.hasSurvey || e.surface === 'mobile') {
      return below
    }

    const { Box, Button, Input, Select } = $.ui.resolve(e)
    const [current, pick, draft, where] = await Promise.all([
      read($, board),
      read($, picked),
      read($, rowDraft),
      read($, scope),
    ])
    const prefix = await prefixOf($, where)
    const open = current.tasks
      .filter(one => one.status !== 'done')
      .sort((a, b) => rowOrder(a) - rowOrder(b) || byPriority(a, b))
    const shown = open.slice(0, MAX_CHOICES)
    const isPicked = shown.some(one => one.number === pick)

    return (
      <Box flexDirection="column">
        {below}
        <Box
          flexDirection="row"
          flexWrap="wrap"
          alignItems="center"
          columnGap={1}
          minHeight={e.surface === 'desktop' ? DESKTOP_ROWS : undefined}
        >
          <Input
            key="capture"
            placeholder={PLACEHOLDER}
            submitLabel="create"
            value={draft}
            onInput={value => void update($, rowDraft, () => value)}
            onSubmit={value => void submitRow($, value)}
          />
          <Box width={GROUP_SPACE} />
          <Select
            key="open"
            label="Task"
            options={[{ value: NONE, label: '–' }, ...shown.map(one => choiceOf(prefix, one))]}
            value={isPicked ? String(pick) : NONE}
            onSelect={value => void update($, picked, () => (value === NONE ? 0 : Number(value)))}
          />
          <Button key="insert" label="Insert" onPress={() => void withPicked($, one => insert($, one))} />
          <Box width={GROUP_SPACE} />
          <Button key="pane" label="Board" onPress={() => void togglePane($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Select, Text } = $.ui.resolve(e)
    const [current, where, view, openedNumber, now, root] = await Promise.all([
      read($, board),
      read($, scope),
      read($, tab),
      read($, opened),
      $.clock.now(),
      $.session.root(),
    ])
    const prefix = where === 'global' ? GLOBAL_PREFIX : projectPrefix(root)
    const task = current.tasks.find(one => one.number === openedNumber)

    if (task !== undefined) {
      const [title, details, deleting] = await Promise.all([read($, titleDraft), read($, detailsDraft), read($, isDeleting)])
      const isChanged = title.trim() !== task.title || details !== task.details
      const meta = `created ${ageOf(now - task.createdAt)} · updated ${ageOf(now - task.updatedAt)}`

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
            <Button key="back" label={isTask(task) ? '‹ Board' : '‹ Snippets'} onPress={() => void back($)} />
            <Text bold>{isTask(task) ? keyOf(prefix, task) : 'Snippet'}</Text>
            <Text dimColor>{meta}</Text>
          </Box>
          <Input
            key="title"
            label="Title"
            submitLabel="save"
            value={title}
            onInput={value => void update($, titleDraft, () => value)}
            onSubmit={() => void save($)}
          />
          <Input
            key="details"
            label="Details"
            placeholder={isTask(task) ? 'Steps, links, acceptance criteria…' : 'The prompt text to reuse…'}
            rows={DETAILS_ROWS}
            submitLabel="save"
            value={details}
            onInput={value => void update($, detailsDraft, () => value)}
            onSubmit={() => void save($)}
          />
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
            <Select
              key="status"
              label="Status"
              options={STATUSES}
              value={task.status}
              onSelect={value => void changeTask($, task.number, one => ({ ...one, status: value as Status }))}
            />
            {isTask(task) && (
              <Select
                key="priority"
                label="Priority"
                options={PRIORITIES.map(({ value, label }) => ({ value, label }))}
                value={task.priority}
                onSelect={value => void changeTask($, task.number, one => ({ ...one, priority: value as Priority }))}
              />
            )}
          </Box>
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
            <Button key="save" variant="primary" label="Save" onPress={() => void save($)} />
            <Button key="insert-task" label="Insert" onPress={() => void insert($, task)} />
            <Button key="delete" label={deleting ? 'Press again to delete' : 'Delete'} onPress={() => void remove($)} />
          </Box>
          {isChanged && <Text color="warning">Unsaved changes. Enter in a field, Save or ‹ Back saves them.</Text>}
        </Box>
      )
    }

    const draft = await read($, newDraft)
    const isWide = e.props.bodyColumns >= BOARD_COLUMNS
    const laneWidth = Math.floor((e.props.bodyColumns - LANE_GAP * (LANES.length - 1)) / LANES.length)

    const card = (one: Task) => {
      const priority = priorityOf(one.priority)
      const at = LANES.findIndex(lane => lane.status === one.status)

      return (
        <Box key={`card-${one.number}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Text dimColor>{isTask(one) ? keyOf(prefix, one) : 'Snippet'}</Text>
            {one.priority !== 'none' && (
              <Text color={priority.color} dimColor={priority.isDim}>
                {priority.label}
              </Text>
            )}
          </Box>
          <Button key={`open-${one.number}`} plain dimColor={one.status === 'done'} onPress={() => void openTask($, one)}>
            <Text strikethrough={one.status === 'done'}>{one.title}</Text>
          </Button>
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box flexDirection="row" columnGap={1}>
              {isTask(one) && at > 0 && (
                <Button key={`left-${one.number}`} plain dimColor label="◂" onPress={() => void move($, one, -1)} />
              )}
              {isTask(one) && at < LANES.length - 1 && (
                <Button key={`right-${one.number}`} plain dimColor label="▸" onPress={() => void move($, one, 1)} />
              )}
              {!isTask(one) && (
                <Button key={`use-${one.number}`} plain dimColor label="Insert" onPress={() => void insert($, one)} />
              )}
            </Box>
            <Text dimColor>{`${one.details.trim() === '' ? '' : '≡ '}${ageOf(now - one.updatedAt)}`}</Text>
          </Box>
        </Box>
      )
    }

    const lane = (status: Status, title: string) => {
      const all = current.tasks.filter(one => one.status === status)
      const sorted = status === 'done' ? [...all].sort(byRecent).slice(0, DONE_SHOWN) : [...all].sort(byPriority)

      return (
        <Box key={`lane-${status}`} flexDirection="column" width={isWide ? laneWidth : undefined}>
          <Box flexDirection="row" columnGap={1}>
            <Text bold>{title}</Text>
            <Text dimColor>{String(all.length)}</Text>
          </Box>
          {sorted.map(card)}
          {all.length === 0 && <Text dimColor>–</Text>}
          {all.length > sorted.length && <Text dimColor>{`+${all.length - sorted.length} older`}</Text>}
        </Box>
      )
    }

    const snippets = current.tasks.filter(one => !isTask(one)).sort(byRecent)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
          {(['board', 'snippets'] as const).map(one => (
            <Button
              key={`tab-${one}`}
              label={one === 'board' ? 'Board' : `Snippets ${snippets.length}`}
              variant={one === view ? 'primary' : 'secondary'}
              onPress={() => void update($, tab, () => one as Tab)}
            />
          ))}
          <Select
            key="scope"
            label="Scope"
            options={[
              { value: 'project', label: `${folderName(root)} · ${projectPrefix(root)}` },
              { value: 'global', label: `Global · ${GLOBAL_PREFIX}` },
            ]}
            value={where}
            onSelect={value => void pickScope($, value)}
          />
        </Box>
        <Input
          key="new"
          placeholder={view === 'snippets' ? 'snippet: A prompt to reuse' : PLACEHOLDER}
          submitLabel="create"
          value={draft}
          onInput={value => void update($, newDraft, () => value)}
          onSubmit={value => void submitNew($, view === 'snippets' && !PREFIX.test(value.trim()) ? `snippet: ${value}` : value)}
        />
        {view === 'board' ? (
          <Box flexDirection={isWide ? 'row' : 'column'} columnGap={LANE_GAP} rowGap={1}>
            {LANES.map(({ status, title }) => lane(status, title))}
          </Box>
        ) : (
          <Box flexDirection="column">
            {snippets.map(card)}
            {snippets.length === 0 && (
              <Text dimColor>No snippets yet. Save a prompt you reuse, then insert it from here or from the row.</Text>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
