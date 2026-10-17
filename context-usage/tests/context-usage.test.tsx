import type { On } from 'claude-code'
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

const world = (on: On, stored: Record<string, unknown> = {}) => {
  const commands: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
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
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
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
    expect(await ui.find({ text: 'Usage limits: no reading yet' })).toBeUndefined()
    await ui.unmount()
  }
})

test('reads no reading yet without any usage limits', async ($, on) => {
  world(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ text: 'Usage limits: no reading yet' })).toBeDefined()
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

  for (const step of [90, 70, 60, 50, 97]) {
    await ui.press({ key: 'threshold' })
    expect((await ui.find({ key: 'threshold' }))?.props.label).toBe(`Auto ${step}%`)
  }

  await ui.unmount()
})

test('the Compact and Clear buttons run their commands', async ($, on) => {
  const { commands } = world(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'compact' })
    await ui.press({ key: 'clear' })
    await ui.unmount()
  }

  expect(commands).toEqual(['compact', 'clear', 'compact', 'clear'])
})
