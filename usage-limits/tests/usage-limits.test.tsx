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

const world = (on: On) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.measure', ($, e) => ({ changed: e.changed }))
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
    const labels = (await ui.findAll({ type: 'Text', text: /limit/ })).map(
      one => one.text.trim(),
    )

    expect(labels).toEqual(['5h limit', 'Weekly limit'])
    expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '18%' })).toBeDefined()
    expect(await ui.find({ text: 'resets in 2h 13m' })).toBeDefined()
    expect(await ui.find({ text: 'resets in 3d 4h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
    await ui.unmount()
  }
})

test('says so while no limit has a reading', async ($, on) => {
  world(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ text: 'no reading yet' })).toBeDefined()
    await ui.unmount()
  }
})
