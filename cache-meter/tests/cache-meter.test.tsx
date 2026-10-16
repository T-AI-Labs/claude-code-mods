import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const MINUTE = 60_000
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

const usageOf = (read: number, written = 0, fresh = 0) => ({
  model: 'claude',
  input_tokens: fresh,
  output_tokens: 5,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: written,
})

const world = (on: On, forkRead = 90) => {
  const forks: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: Date.parse('2026-10-16T10:00:00Z') })
  mock.store(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn',
      usage: usageOf(80, 10, 10),
    }
  })
  on('model.fork', ($, e) => {
    forks.push(e.prompt)

    return { value: { isAnswered: true, text: 'OK', usage: usageOf(forkRead, 2, 8) } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(String(e.text))

    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>below</Text>
  })

  return { forks, toasts, clock }
}

const step = async ($: Engine) => {
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude', messageCount: 3 })

  for await (const chunk of stream) {
    void chunk
  }

  await stream.result
}

const turn = async ($: Engine, read = 80, written = 10, fresh = 10) => {
  await step($)
  await $.turn.complete({
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
    usage: usageOf(read, written, fresh),
  })
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

test('shows the hit rate of the last turn and counts down until the cache goes cold', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($)
  await clock.advance(1000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: '80%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '(80/100)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'warm 4:59' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
    await ui.unmount()
  }

  await clock.advance(5 * MINUTE)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: 'cold' })).toBeDefined()
  await ui.unmount()
})

test('draws five-segment gauges by default', async ($, on) => {
  world(on)
  await start($)
  await turn($, 40, 50, 10)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ type: 'Text', text: /^▮{2}$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▯{3}$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('shows no gauge when display is text', { options: { display: 'text' } }, async ($, on) => {
  world(on)
  await start($)
  await turn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: '80%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /[▮▯]/ })).toBeUndefined()
  await ui.unmount()
})

test('leaves the token counts out when details is off', { options: { details: false } }, async ($, on) => {
  world(on)
  await start($)
  await turn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: '80%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '(80/100)' })).toBeUndefined()
  await ui.unmount()
})

test('never refreshes the cache unless Keep warm is switched on', async ($, on) => {
  const { forks, clock } = world(on)
  await start($)
  await turn($)
  await clock.advance(20 * MINUTE)

  expect(forks).toEqual([])
})

test('Keep warm refreshes the cache before it lapses, up to the configured minutes', { options: { keepWarmMinutes: '15' } }, async ($, on) => {
  const { forks, clock } = world(on)
  await start($)
  await turn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'keep-warm' })
  await clock.advance(4 * MINUTE + 25_000)

  expect(forks).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /^warm 4:5\d$/ })).toBeDefined()
  expect((await ui.find({ key: 'keep-warm' }))?.props.label).toMatch(/Keeping warm 11m · 1×/)

  await clock.advance(20 * MINUTE)

  expect(forks).toHaveLength(3)
  expect(await ui.find({ type: 'Text', text: 'cold' })).toBeDefined()
  expect((await ui.find({ key: 'keep-warm' }))?.props.label).toBe('Kept warm · 3×')
  await ui.unmount()
})

test('Keep warm stops when a refresh shows the cache had already lapsed', async ($, on) => {
  const { forks, toasts, clock } = world(on, 0)
  await start($)
  await turn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'keep-warm' })
  await clock.advance(10 * MINUTE)

  expect(forks).toHaveLength(1)
  expect(toasts).toEqual(['cache-meter: Keep warm stopped, the cache had already lapsed.'])
  expect((await ui.find({ key: 'keep-warm' }))?.props.label).toBe('Keep warm')
  await ui.unmount()
})

test('learns that the session caches for an hour from a hit after a long pause', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($)
  await clock.advance(10 * MINUTE)
  await turn($)
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: 'warm 59:59' })).toBeDefined()
  await ui.unmount()
})
