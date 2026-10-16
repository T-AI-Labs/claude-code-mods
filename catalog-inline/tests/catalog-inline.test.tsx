import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const TYPED = {
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const row = (args: string) =>
  ({
    plugin: 'catalog-inline',
    component: 'CommandOutput',
    requestId: `row-${args || 'all'}`,
    props: { command: 'catalog-inline', args, text: 'Catalog', isErrored: false },
  }) as const

const BAND = {
  plugin: 'catalog-inline',
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
  const filled: string[] = []
  const ran: string[] = []
  mock.clock(on, { now: Date.parse('2026-10-16T10:00:00Z') })
  mock.store(on, {})
  mock.env(on, { USERPROFILE: 'C:/home' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({
    value: [
      { name: 'simplify', description: 'Review changed code for reuse', source: 'builtin' },
      { name: 'review', description: 'Review a pull request', source: 'builtin' },
      { name: 'auto:fix', description: 'Fix a bug from its ticket', source: 'plugin', plugin: 'auto' },
    ],
  }))
  on('tool.list', () => ({ value: [{ name: 'Bash', description: 'Runs a shell command.', mcp: false }] }))
  on('settings.read', () => ({ value: {} }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>below</Text>
  })
  on('command.run', ($, e) => {
    ran.push(e.command)

    return { text: '' }
  })

  return { filled, ran }
}

test('summarises the catalog in the command output the model reads', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const result = await $.command.run({ ...TYPED, command: 'catalog-inline' })

  expect(result.text).toBe('Catalog: 0 skills, 3 commands, 0 agents, 1 plugins, 0 mcp, 1 tools.')
})

test('picks a category and an entry from dropdowns and shows its details', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'catalog-inline' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...row(''), surface })
    await ui.select({ key: 'kind', value: 'command' })
    await ui.select({ key: 'entry', value: 'command:review' })

    expect(await ui.find({ type: 'Text', text: 'review' })).toBeDefined()
    expect(await ui.find({ key: 'run' })).toBeDefined()
    await ui.unmount()
  }
})

test('navigates from a plugin to what it provides and back', async ($, on) => {
  const { ran } = world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'catalog-inline', args: 'plugins' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...row('plugins'), surface })

    expect(await ui.find({ type: 'Text', text: 'auto' })).toBeDefined()

    await ui.press({ key: 'item-command:auto:fix' })
    await ui.press({ key: 'run' })

    expect(await ui.find({ key: 'back' })).toBeDefined()

    await ui.press({ key: 'back' })

    expect(await ui.find({ key: 'back' })).toBeUndefined()
    await ui.unmount()
  }

  expect(ran.filter(name => name === 'auto:fix')).toHaveLength(2)
})

test('shows a row above the prompt from the start, above the other bands', async ($, on) => {
  const { filled } = world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'catalog-inline' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.select({ key: 'band-kind', value: 'command' })
    await ui.select({ key: 'band-entry', value: 'command:review' })

    expect(await ui.find({ type: 'Text', text: /Review a pull request/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()

    await ui.press({ key: 'insert' })
    await ui.press({ key: 'band-more' })

    expect(await ui.find({ key: 'explain' })).toBeDefined()

    await ui.press({ key: 'band-more' })
    await ui.unmount()
  }

  expect(filled).toEqual(['/review ', '/review '])
})
