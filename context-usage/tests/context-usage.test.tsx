import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-10-12T10:00:00Z')
const BAND = {
  plugin: 'context-usage',
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
const LIMITS = [
  { kind: 'seven_day', percentUsed: 18.4, resetsAt: '2026-10-15T14:00:00Z' },
  { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-12T12:13:00Z' },
]

const measured = (percent: number) => ({
  context: { tokens: percent * 2000, window: 200_000, percent },
  rateLimits: LIMITS,
  changed: ['context' as const, 'rateLimits' as const],
})

// A Map stands for the store file every session shares: the test writes to it as another session would.
const share = (on: On, stored: Record<string, unknown> | Map<string, unknown>) => {
  if (!(stored instanceof Map)) {
    return mock.store(on, stored)
  }

  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
}

const world = (on: On, stored: Record<string, unknown> | Map<string, unknown> = {}) => {
  const commands: string[] = []
  const clock = mock.clock(on, { now: NOW })
  share(on, stored)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('classic.SessionStart', () => ({}))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.run', ($, e) => {
    commands.push(e.command)

    return { text: '' }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>below</Text>
  })

  return { commands, clock }
}

const labels = async (ui: { findAll: (query: object) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text', text: /^(Context| 5h|Week)$/ })).map(one =>
    one.text.trim(),
  )

test('shows the context row with its controls and the usage row beneath it', async ($, on) => {
  world(on)
  await $.session.measure(measured(41))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await labels(ui)).toEqual(['Context', '5h', 'Week'])
    expect(await ui.find({ type: 'Text', text: '41%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(82k/200k)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(2h 13m)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(3d 4h)' })).toBeDefined()
    expect(await ui.find({ type: 'Select', key: 'threshold' })).toBeDefined()
    expect(await ui.find({ text: /compact/i })).toBeDefined()
    expect(await ui.find({ text: /clear/i })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
    await ui.unmount()
  }
})

test('draws the usage row on top when usagePosition is above', { options: { usagePosition: 'above' } }, async ($, on) => {
  world(on)
  await $.session.measure(measured(41))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await labels(ui)).toEqual(['5h', 'Week', 'Context'])
    await ui.unmount()
  }
})

test('leaves the figures in parentheses and the gauges out when asked', { options: { display: 'text', details: false } }, async ($, on) => {
  world(on)
  await $.session.measure(measured(41))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '41%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\(/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /[▮▯]/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('shows an empty context and the last usage reading before the first response', async ($, on) => {
  world(on, { reading: { windows: LIMITS } })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '0%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(0/200k)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
    await ui.unmount()
  }
})

test('brings the threshold, an empty context and the usage reading back after a /clear', async ($, on) => {
  world(on, { threshold: 70, reading: { windows: LIMITS } })
  await $.session.measure(measured(41))
  await $.classic.SessionStart({ source: 'clear' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '0%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(0/200k)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
    expect((await ui.find({ key: 'threshold' }))?.props.value).toBe('70')
    await ui.unmount()
  }
})

test('shows 5h and Week without a figure while no limit has a reading', async ($, on) => {
  world(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await labels(ui)).toEqual(['Context', '5h', 'Week'])
    expect(await ui.findAll({ type: 'Text', text: '–' })).toHaveLength(3)
    await ui.unmount()
  }
})

test('keeps a window that has reset since the stored reading, at zero, after a /clear', async ($, on) => {
  const { clock } = world(on, { reading: { windows: LIMITS } })
  await clock.advance(3 * 60 * 60_000)
  await $.classic.SessionStart({ source: 'clear' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await labels(ui)).toEqual(['Context', '5h', 'Week'])
    expect(await ui.findAll({ type: 'Text', text: '0%' })).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: '42%' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '18%' })).toBeDefined()
    await ui.unmount()
  }
})

test('compacts once at the stored threshold and re-arms below it', async ($, on) => {
  const { commands, clock } = world(on, { threshold: 50 })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await $.session.measure(measured(49))
  await clock.advance(1000)
  expect(commands).toEqual([])

  await $.session.measure(measured(55))
  await $.session.measure(measured(58))
  await clock.advance(1000)
  expect(commands).toEqual(['compact'])

  await $.session.measure(measured(20))
  await $.session.measure(measured(51))
  await clock.advance(1000)
  expect(commands).toEqual(['compact', 'compact'])
})

test('on mobile the threshold is a button that steps through the values', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'mobile' })

  for (const label of ['90%', '70%', '60%', '50%', 'Off', '97%']) {
    await ui.press({ key: 'threshold' })
    expect((await ui.find({ key: 'threshold' }))?.props.label).toBe(`Auto ${label}`)
  }

  await ui.unmount()
})

test('the threshold picker starts with Off', async ($, on) => {
  world(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ key: 'threshold' }))?.props.options).toEqual([
      { value: '0', label: 'Off' },
      ...[97, 90, 70, 60, 50].map(step => ({ value: `${step}`, label: `${step}%` })),
    ])
    await ui.select({ key: 'threshold', value: '0' })
    expect((await ui.find({ key: 'threshold' }))?.props.value).toBe('0')
    await ui.unmount()
  }
})

test('never compacts while the threshold is off', async ($, on) => {
  const { commands, clock } = world(on, { threshold: 0 })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await $.session.measure(measured(99))
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('Compact and Clear are buttons on every surface', async ($, on) => {
  world(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.findAll({ type: 'Button' })).map(one => one.key)).toEqual(['compact', 'clear'])
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Compact and Clear run their commands on every surface', async ($, on) => {
  const { commands } = world(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'compact' })
    await ui.press({ key: 'clear' })
    await ui.unmount()
  }

  expect(commands).toEqual(['compact', 'clear', 'compact', 'clear'])
})

test('keeps the last reading of a window a measurement leaves out, also after a /clear', async ($, on) => {
  world(on)
  await $.session.measure(measured(41))
  await $.session.measure({
    ...measured(41),
    rateLimits: [{ kind: 'five_hour', percentUsed: 47, resetsAt: '2026-10-12T12:13:00Z' }],
  })
  await $.classic.SessionStart({ source: 'clear' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '47%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '18%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '–' })).toBeUndefined()
    await ui.unmount()
  }
})

const MINUTE = 60_000
const FIVE_HOUR = '2026-10-12T12:13:00Z'
const NEXT_FIVE_HOUR = '2026-10-12T17:13:00Z'
const WEEK = '2026-10-15T14:00:00Z'

const limits = (fiveHour: number, resetsAt = FIVE_HOUR) => ({
  context: { tokens: 0, window: 200_000, percent: 0 },
  rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour, resetsAt }],
  changed: ['rateLimits' as const],
})

const usage = async ($: Engine, surface: (typeof SURFACES)[number]) => {
  const ui = await $.ui.mount({ ...BAND, surface })
  const shown = (await ui.findAll({ type: 'Text', text: /^\d+%$/ })).map(one => one.text).slice(1)
  await ui.unmount()

  return shown
}

test('takes in a higher reading another session stored, within a minute and without a turn', async ($, on) => {
  const store = new Map<string, unknown>()
  const { clock } = world(on, store)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.session.measure(limits(42))

  store.set('reading', {
    windows: [
      { kind: 'five_hour', percentUsed: 55, resetsAt: FIVE_HOUR },
      { kind: 'seven_day', percentUsed: 30, resetsAt: WEEK },
    ],
  })
  await clock.advance(MINUTE)

  for (const surface of SURFACES) {
    expect(await usage($, surface)).toEqual(['55%', '30%'])
  }
})

test('keeps the higher reading of a window when its own measurement is lower', async ($, on) => {
  const store = new Map<string, unknown>([
    ['reading', { windows: [{ kind: 'five_hour', percentUsed: 55, resetsAt: FIVE_HOUR }] }],
  ])
  world(on, store)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.session.measure(limits(42))

  for (const surface of SURFACES) {
    expect(await usage($, surface)).toEqual(['55%'])
  }

  expect(store.get('reading')).toEqual({
    windows: [{ kind: 'five_hour', percentUsed: 55, resetsAt: FIVE_HOUR }],
  })
})

test('a later window wins over a higher reading of the one before it', async ($, on) => {
  const store = new Map<string, unknown>([
    ['reading', { windows: [{ kind: 'five_hour', percentUsed: 80, resetsAt: FIVE_HOUR }] }],
  ])
  const { clock } = world(on, store)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.session.measure(limits(5, NEXT_FIVE_HOUR))

  store.set('reading', {
    windows: [{ kind: 'five_hour', percentUsed: 90, resetsAt: FIVE_HOUR }],
  })
  await clock.advance(MINUTE)

  for (const surface of SURFACES) {
    expect(await usage($, surface)).toEqual(['5%'])
  }
})
