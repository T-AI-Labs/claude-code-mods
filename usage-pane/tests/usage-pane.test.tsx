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

type Usage = typeof USAGE

type World = { id: string; root: string; usd: number; steps: Usage[] }

const world = (on: On, stored: Map<string, unknown> = new Map()) => {
  const clock = mock.clock(on, { now: NOW })
  const session: World = { id: 's1', root: '/work/demo', usd: 0, steps: [] }

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
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: session.steps.shift() ?? null,
    }
  })
  on('tool.call', ($, e) => ({ result: {}, text: 'x'.repeat(e.tool === 'Read' ? 120_000 : 100) }))

  return { clock, session, stored }
}

const step = (context: number, output = 500): Usage => ({
  input_tokens: 0,
  output_tokens: output,
  cache_read_input_tokens: context - 1_000,
  cache_creation_input_tokens: 1_000,
  model: 'claude-opus-5-5',
})

const summed = (steps: Usage[]): Usage => ({
  input_tokens: steps.reduce((all, one) => all + one.input_tokens, 0),
  output_tokens: steps.reduce((all, one) => all + one.output_tokens, 0),
  cache_read_input_tokens: steps.reduce((all, one) => all + one.cache_read_input_tokens, 0),
  cache_creation_input_tokens: steps.reduce((all, one) => all + one.cache_creation_input_tokens, 0),
  model: 'claude-opus-5-5',
})

const ask = async ($: Engine, session: World, text: string, usd: number, steps: Usage[], reads = 0) => {
  const turnId = `p-${text}`
  session.steps = [...steps]
  await $.turn.start({ text, turnId })

  for (const index of steps.keys()) {
    const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1 })

    for await (const _ of stream) {
    }
  }

  for (let count = 0; count < reads; count += 1) {
    await $.tool.call({ tool: 'Read', file_path: `/work/demo/big-${count}.ts` })
  }

  session.usd = usd
  await $.turn.complete({
    answer: '',
    durationMs: 60_000,
    isAborted: false,
    turnId,
    reason: 'answer',
    usage: summed(steps),
  })
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

test('lists the prompts of the session by cost and says what made the top one expensive', async ($, on) => {
  const { session, clock } = world(on)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await ask($, session, 'Rename the helper', 0.05, [step(20_000), step(21_000)])
  await clock.advance(60_000)
  await ask($, session, 'Fix the  login\nbug', 0.45, Array.from({ length: 30 }, () => step(120_000)), 2)
  await open($, 'prompts')
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: 'Fix the login bug' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$0.40' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Where the cost went' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Re-reading context' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /context reached 120k tokens and each of the 30 model calls/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^• 30 model calls for one prompt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Read returned about 60k tokens over 2 calls/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `prompt-${NOW}` })
  expect(await ui.find({ type: 'Text', text: 'Rename the helper' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Nothing stood out.' })).toBeDefined()
  await ui.unmount()
})

test('lists the sessions and opens the prompts of another one', async ($, on) => {
  const prompt = {
    at: NOW - DAY,
    text: 'Write the release notes',
    model: 'claude-sonnet-5-5',
    ms: 30_000,
    usd: 0.3,
    steps: 4,
    peakContext: 30_000,
    firstWrite: 60_000,
    isAborted: false,
    input: 0,
    output: 2_000,
    cacheRead: 60_000,
    cacheWrite: 60_000,
    agents: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, runs: 0 },
    tools: {},
  }
  const stored = new Map<string, unknown>([
    [
      'session:other',
      {
        project: 'elsewhere',
        lastAt: NOW - DAY,
        usdSeen: 0.3,
        model: 'claude-sonnet-5-5',
        title: 'Write the release notes',
        prompts: [prompt],
        days: {
          '2026-10-11': {
            'claude-sonnet-5-5': {
              input: 0,
              output: 2_000,
              cacheRead: 60_000,
              cacheWrite: 60_000,
              turns: 1,
              tools: 0,
              ms: 30_000,
              usd: 0.3,
            },
          },
        },
      },
    ],
  ])
  const { session, clock } = world(on, stored)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await ask($, session, 'Add a test', 0.1, [step(20_000)])
  await open($, 'sessions')
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /\$0\.10 .* demo · 1 prompts · Add a test/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /\$0\.30 .* elsewhere · 1 prompts · Write the release notes/ })).toBeDefined()
  await ui.press({ key: 'session-other' })
  expect(await ui.find({ type: 'Text', text: 'Write the release notes' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /prompt cache was cold: 60k tokens/ })).toBeDefined()
  await ui.unmount()
})

test('drops prompt details after a week but keeps the counts', async ($, on) => {
  const stored = new Map<string, unknown>([
    ['session:old', { project: 'p', lastAt: NOW - 10 * DAY, usdSeen: 0, model: 'm', days: {}, prompts: [] }],
  ])
  const { clock } = world(on, stored)
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(stored.get('session:old')).toEqual({ project: 'p', lastAt: NOW - 10 * DAY, usdSeen: 0, model: 'm', days: {} })
})
