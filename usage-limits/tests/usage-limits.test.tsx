import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-10-12T10:00:00Z')
const BAND = {
  plugin: 'usage-limits',
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

const world = (on: On, stored: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('classic.SessionStart', () => ({}))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>below</Text>
  })

  return clock
}

test('shows the 5-hour and weekly limits in percent with their resets', async ($, on) => {
  world(on)
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 18.4, resetsAt: '2026-10-15T14:00:00Z' },
      { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-12T12:13:00Z' },
    ],
    changed: ['rateLimits'],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const labels = (await ui.findAll({ type: 'Text', text: /^( 5h|Week)$/ })).map(
      one => one.text.trim(),
    )

    expect(labels).toEqual(['5h', 'Week'])
    expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '18%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(2h 13m)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(3d 4h)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
    await ui.unmount()
  }
})

test('draws five-segment gauges by default', async ($, on) => {
  world(on)
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42 }],
    changed: ['rateLimits'],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: /^▮{2}$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▯{3}$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('shows 5h and Week without a figure while no limit has a reading', async ($, on) => {
  world(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const labels = (await ui.findAll({ type: 'Text', text: /^( 5h|Week)$/ })).map(
      one => one.text.trim(),
    )

    expect(labels).toEqual(['5h', 'Week'])
    expect(await ui.findAll({ type: 'Text', text: '–' })).toHaveLength(2)
    await ui.unmount()
  }
})

test('starts a window over at zero once it has reset', async ($, on) => {
  const clock = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-12T12:13:00Z' },
      { kind: 'seven_day', percentUsed: 18.4, resetsAt: '2026-10-15T14:00:00Z' },
    ],
    changed: ['rateLimits'],
  })
  await clock.advance(3 * 60 * 60_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: ' 5h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '0%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '42%' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '18%' })).toBeDefined()
    await ui.unmount()
  }
})

test('draws its row under the rows beneath it', async ($, on) => {
  world(on)
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42 }],
    changed: ['rateLimits'],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)

    expect(texts.indexOf('below')).toBeLessThan(texts.indexOf(' 5h'))
    await ui.unmount()
  }
})

test('shows the stored reading without its age until the first response', async ($, on) => {
  const clock = world(on, {
    reading: {
      at: Date.parse('2026-10-12T06:40:00Z'),
      windows: [
        { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-12T09:00:00Z' },
        { kind: 'seven_day', percentUsed: 18.4, resetsAt: '2026-10-15T14:00:00Z' },
      ],
    },
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '18%' })).toBeDefined()
    expect(await ui.find({ text: /as of/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: ' 5h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '0%' })).toBeDefined()
    await ui.unmount()
  }

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 7 }],
    changed: ['rateLimits'],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '7%' })).toBeDefined()
    expect(await ui.find({ text: /as of/ })).toBeUndefined()
    await ui.unmount()
  }

  await clock.advance(5 * 60_000)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '7%' })).toBeDefined()
    expect(await ui.find({ text: /as of/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('keeps the last reading when a measurement carries no limits', async ($, on) => {
  world(on)
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-12T12:13:00Z' },
      { kind: 'seven_day', percentUsed: 18.4, resetsAt: '2026-10-15T14:00:00Z' },
    ],
    changed: ['rateLimits'],
  })
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [],
    changed: ['rateLimits'],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '18%' })).toBeDefined()
    await ui.unmount()
  }
})

test('brings the stored reading back after a /clear', async ($, on) => {
  world(on, {
    reading: {
      windows: [
        { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-12T12:13:00Z' },
        { kind: 'seven_day', percentUsed: 18.4, resetsAt: '2026-10-15T14:00:00Z' },
      ],
    },
  })
  await $.classic.SessionStart({ source: 'clear' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(2h 13m)' })).toBeDefined()
    await ui.unmount()
  }
})

test('keeps the last reading of a window a measurement leaves out, also after a /clear', async ($, on) => {
  world(on)
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-12T12:13:00Z' },
      { kind: 'seven_day', percentUsed: 18.4, resetsAt: '2026-10-15T14:00:00Z' },
    ],
    changed: ['rateLimits'],
  })
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 7, resetsAt: '2026-10-12T12:13:00Z' }],
    changed: ['rateLimits'],
  })
  await $.classic.SessionStart({ source: 'clear' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '7%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '18%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '–' })).toBeUndefined()
    await ui.unmount()
  }
})
