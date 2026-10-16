import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const TYPED = {
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const
const PANE = {
  plugin: 'catalog-pane',
  component: 'Pane',
  requestId: 'catalog',
  props: {
    title: 'Catalog',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
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
      { name: 'find-skills', description: 'Discover agent skills', source: 'user' },
    ],
  }))
  on('tool.list', () => ({
    value: [
      { name: 'Bash', description: 'Runs a shell command.\n\nLong details.', mcp: false },
      { name: 'mcp__github__create_issue', description: 'Create an issue', mcp: true },
    ],
  }))
  on('settings.read', () => ({ value: {} }))
  on('fs.list', ($, e) =>
    e.path.replaceAll('\\', '/') === 'C:/home/.claude/skills'
      ? { value: [{ name: 'find-skills', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
      : { deny: 'ENOENT' },
  )
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('command.run', ($, e) => {
    ran.push(e.command)

    return { text: '' }
  })

  return { filled, ran }
}

test('lists each category with its count and describes the entries', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'catalog' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ key: 'tab-skill' }))?.props.label).toBe('Skills 1')
    expect((await ui.find({ key: 'tab-command' }))?.props.label).toBe('Commands 2')
    expect((await ui.find({ key: 'tab-mcp' }))?.props.label).toBe('MCP 1')
    expect(await ui.find({ type: 'Text', text: 'Discover agent skills' })).toBeDefined()
    await ui.unmount()
  }
})

test('counts command runs and sorts the most used first', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'review' })
  await $.command.run({ ...TYPED, command: 'catalog', args: 'commands' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('open-'))
    const first = rows[0]

    expect(first?.key).toBe('open-command:review')
    expect(first?.text).toMatch(/1×/)
    await ui.unmount()
  }
})

test('opens an entry, navigates back and inserts it into the prompt', async ($, on) => {
  const { filled } = world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'catalog', args: 'tools' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open-tool:Bash' })

    expect(await ui.find({ type: 'Text', text: 'Bash' })).toBeDefined()
    expect(await ui.find({ key: 'explain' })).toBeDefined()

    await ui.press({ key: 'insert' })
    await ui.press({ key: 'back' })

    expect(await ui.find({ key: 'open-tool:Bash' })).toBeDefined()
    await ui.unmount()
  }

  expect(filled).toEqual(['Use the Bash tool to ', 'Use the Bash tool to '])
})

test('filters the list on the desktop', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'catalog', args: 'commands' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'query', text: 'pull', kind: 'change' })

  expect(await ui.find({ key: 'open-command:review' })).toBeDefined()
  expect(await ui.find({ key: 'open-command:simplify' })).toBeUndefined()
  await ui.unmount()
})
