import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-10-12T10:00:00Z')
const DAY = 24 * 60 * 60_000
const TYPED = {
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const
const PANE = {
  plugin: 'usage-pane',
  component: 'Pane',
  requestId: 'usage',
  props: {
    title: 'Usage',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const USAGE = {
  input_tokens: 2_000,
  output_tokens: 8_000,
  cache_read_input_tokens: 90_000,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
}

type World = { id: string; root: string; usd: number }

const world = (on: On, stored: Map<string, unknown> = new Map()) => {
  const clock = mock.clock(on, { now: NOW })
  const session: World = { id: 's1', root: '/work/demo', usd: 0 }

  // A Map stands for the store file every session shares.
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    stored.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...stored.keys()] }))
  on('session.id', () => ({ value: session.id }))
  on('session.root', () => ({ value: session.root }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [],
      cost: { usd: session.usd },
    },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))

  return { clock, session, stored }
}

const turn = async ($: Engine, session: World, usd: number, agentId?: string) => {
  session.usd = usd
  await $.turn.complete({
    answer: '',
    durationMs: 90_000,
    isAborted: false,
    turnId: `t-${usd}`,
    reason: 'answer',
    usage: USAGE,
    ...(agentId === undefined ? {} : { agentId }),
  })
}

const open = async ($: Engine, args = '') => {
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'tokens', args })
}

test('adds up the tokens, cache hit rate, price, turns and tool calls of the week', async ($, on) => {
  const { session, clock } = world(on)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'pwd' })
  await turn($, session, 0.5)
  await turn($, session, 0.8, 'agent-1')
  await turn($, session, 1.25)
  await open($)
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: '300k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /input 6k · output 24k · cache read 270k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '98%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$1.25' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3m in all' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'claude-opus-5-5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'unknown' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'demo' })).toBeDefined()

    const counts = (await ui.findAll({ type: 'Text', text: /^2$/ })).length
    expect(counts).toBe(2)
    await ui.unmount()
  }
})

test('shows the last turn alone', async ($, on) => {
  const { session, clock } = world(on)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await turn($, session, 0.5)
  await turn($, session, 0.75)
  await open($, 'turn')
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: '100k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$0.25' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Tool calls' })).toBeUndefined()
  await ui.unmount()
})

test('counts other sessions in the week but not in this session', async ($, on) => {
  const stored = new Map<string, unknown>([
    [
      'session:other',
      {
        project: 'elsewhere',
        lastAt: NOW - DAY,
        usdSeen: 2,
        model: 'claude-sonnet-5-5',
        days: {
          '2026-10-11': {
            'claude-sonnet-5-5': {
              input: 1_000,
              output: 1_000,
              cacheRead: 0,
              cacheWrite: 0,
              turns: 1,
              tools: 0,
              ms: 60_000,
              usd: 2,
            },
          },
        },
      },
    ],
  ])
  const { session, clock } = world(on, stored)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await turn($, session, 0.5)
  await open($)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'elsewhere' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$2.50' })).toBeDefined()
  await ui.press({ key: 'period-session' })
  expect(await ui.find({ type: 'Text', text: '$0.50' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'claude-sonnet-5-5' })).toBeUndefined()
  await ui.unmount()
})

test('keeps the peak of each limit window', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })

  for (const percentUsed of [20, 64, 30]) {
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: '2026-10-12T08:00:00Z' }],
      changed: ['rateLimits'],
    })
  }

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-12T13:00:00Z' }],
    changed: ['rateLimits'],
  })
  await open($)
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: '5-hour' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '12%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '64%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^now, resets .* \(in 3h 0m\)$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('drops sessions older than a month once a day', async ($, on) => {
  const stored = new Map<string, unknown>([
    ['session:old', { project: 'p', lastAt: NOW - 40 * DAY, usdSeen: 0, model: 'm', days: {} }],
    ['session:new', { project: 'p', lastAt: NOW - 2 * DAY, usdSeen: 0, model: 'm', days: {} }],
  ])
  const { clock } = world(on, stored)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(stored.has('session:old')).toBe(false)
  expect(stored.has('session:new')).toBe(true)
})
