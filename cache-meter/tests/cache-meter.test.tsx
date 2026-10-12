import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  plugin: 'cache-meter',
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
const TURN = {
  answer: 'done',
  durationMs: 1,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'answer',
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
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
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

test('shows the cache hit rate and the context fill in one row', async ($, on) => {
  world(on)
  await $.turn.complete({
    ...TURN,
    usage: {
      model: 'claude',
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
    },
  })
  await $.session.measure(measured(41))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '80%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '41%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(80/100)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(82k/200k)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
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

test('the threshold button cycles 97, 90, 70, 60, 50 and wraps', async ($, on) => {
  world(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    for (const step of [90, 70, 60, 50, 97]) {
      await ui.press({ key: 'threshold' })
      expect((await ui.find({ key: 'threshold' }))?.props.label).toBe(
        `Auto-compact ${step}%`,
      )
    }

    await ui.unmount()
  }
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
