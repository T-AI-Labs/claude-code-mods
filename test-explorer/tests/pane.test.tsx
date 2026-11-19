import type { FsEntry } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'test-explorer',
  component: 'Pane',
  requestId: 'test-explorer',
  props: {
    title: 'Tests',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const


const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const file = (name: string): FsEntry => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })

const TREE: Record<string, FsEntry[]> = {
  '/repo': [dir('my-mod'), dir('node_modules')],
  '/repo/my-mod': [dir('.claude-plugin'), dir('tests'), dir('hooks')],
  '/repo/my-mod/tests': [file('pane.test.tsx')],
  '/repo/my-mod/hooks': [],
}

test('finds a mod project, runs it and offers a fix for the failing test', async ($, on) => {
  const clock = mock.clock(on)
  const ran: string[][] = []
  const prompts: string[] = []
  // The engine resolves fs paths before the hooks see them: /repo arrives as C:\repo on Windows.
  on('fs.list', (_, e) => ({ value: TREE[e.path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')] ?? [] }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.read', () => ({ value: "test('opens', () => {})\ntest('counts', () => {})" }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])

    return {
      value: {
        exitCode: 1,
        stdout: 'tests\\pane.test.tsx:\n(pass) opens [1ms]\n(fail) counts [2ms]\n  AssertionError: expected 2 to be 3\n',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)

    return { text: e.text }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scan' })
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: 'Claude Code mods' }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /2 tests/ }))?.text).toBeDefined()

  await ui.press({ key: 'run|claude-plugin:my-mod' })
  await clock.settle()

  expect(ran).toEqual([['claude', 'plugin', 'test', '/repo/my-mod']])
  expect((await ui.find({ type: 'Text', text: /expected 2 to be 3/ }))?.text).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Duration' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 ms' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 passed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 tests · 1 failed/ })).toBeDefined()

  await ui.press({ key: 'fix|claude-plugin:my-mod|counts' })
  expect(prompts[0]).toContain('`counts`')
  expect(prompts[0]).toContain('expected 2 to be 3')
  await ui.unmount()
})
