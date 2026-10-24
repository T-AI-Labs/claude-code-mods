import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  plugin: 'context-meter',
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

const measured = (percent: number) => ({
  context: { tokens: percent * 2000, window: 200_000, percent },
  rateLimits: [],
  changed: ['context' as const],
})

const world = (on: On, stored?: number) => {
  const commands: string[] = []
  const clock = mock.clock(on)
  mock.store(on, stored === undefined ? {} : { threshold: stored })
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

test('shows the context fill with the threshold, Compact and Clear in one row', async ($, on) => {
  world(on)
  await $.session.measure(measured(41))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '41%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Cache' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '(82k/200k)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
    expect(await ui.find({ text: /Compact/ })).toBeDefined()
    expect(await ui.find({ text: /Clear/ })).toBeDefined()
    expect(await ui.find({ type: 'Select', key: 'threshold' })).toBeDefined()
    await ui.unmount()
  }
})

test('draws five-segment gauges by default', async ($, on) => {
  world(on)
  await $.session.measure(measured(41))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: /^▮{2}$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▯{3}$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('keeps the details and gauges on a narrow band', async ($, on) => {
  world(on)
  await $.session.measure(measured(41))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      ...BAND,
      props: { ...BAND.props, bodyColumns: 60 },
      surface,
    })

    expect(await ui.find({ type: 'Text', text: '(82k/200k)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▮{2}$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('shows no gauge when display is text', { options: { display: 'text' } }, async ($, on) => {
  world(on)
  await $.session.measure(measured(41))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '41%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /[▮▯]/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('leaves the token counts out when details is off', { options: { details: false } }, async ($, on) => {
  world(on)
  await $.session.measure(measured(41))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '41%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(82k/200k)' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the threshold is a picker over Off, 97, 90, 70, 60 and 50', async ($, on) => {
  world(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const options = (await ui.find({ key: 'threshold' }))?.props.options

    expect(options).toEqual([
      { value: '0', label: 'Off' },
      ...[97, 90, 70, 60, 50].map(step => ({ value: `${step}`, label: `${step}%` })),
    ])

    for (const step of [70, 0, 50, 97]) {
      await ui.select({ key: 'threshold', value: `${step}` })
      expect((await ui.find({ key: 'threshold' }))?.props.value).toBe(`${step}`)
    }

    await ui.unmount()
  }
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

test('Compact and Clear are buttons on the terminal and text links on the desktop', async ($, on) => {
  world(on)
  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await terminal.findAll({ type: 'Button' })).map(one => one.key)).toEqual(['compact', 'clear'])
  expect(await terminal.find({ type: 'Markdown' })).toBeUndefined()
  await terminal.unmount()

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await desktop.findAll({ type: 'Button' })).toHaveLength(0)
  expect((await desktop.find({ type: 'Markdown', key: 'actions' }))?.props.text).toBe(
    '[Compact](https://context-meter.invalid/compact) · [Clear](https://context-meter.invalid/clear)',
  )
  await desktop.unmount()
})

test('never compacts while the threshold is off', async ($, on) => {
  const { commands, clock } = world(on, 0)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await $.session.measure(measured(99))
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('compacts once at the stored threshold and re-arms below it', async ($, on) => {
  const { commands, clock } = world(on, 50)
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

test('Compact and Clear run their commands as buttons and as links', async ($, on) => {
  const { commands } = world(on)

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await terminal.press({ key: 'compact' })
  await terminal.press({ key: 'clear' })
  await terminal.unmount()

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await desktop.press({ key: 'actions', link: { href: 'https://context-meter.invalid/compact' } })
  await desktop.press({ key: 'actions', link: { href: 'https://context-meter.invalid/clear' } })
  await desktop.unmount()

  expect(commands).toEqual(['compact', 'clear', 'compact', 'clear'])
})

test('shows an empty context with its window after a /clear', async ($, on) => {
  world(on, 70)
  await $.session.measure(measured(41))
  await $.classic.SessionStart({ source: 'clear' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '0%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(0/200k)' })).toBeDefined()
    expect((await ui.find({ key: 'threshold' }))?.props.value).toBe('70')
    await ui.unmount()
  }
})
