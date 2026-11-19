import type { Status, TestCase, Tool } from '../types'

export type Outcome = { name: string; group?: string; status: Status; ms?: number; message?: string }

export const TOOL_LABEL: Record<Tool, string> = {
  dotnet: '.NET',
  pytest: 'pytest',
  vitest: 'Vitest',
  'claude-plugin': 'Claude Code mods',
}

const MAX_MESSAGE = 4000

const plain = (text: string) =>
  text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

const lines = (text: string) => plain(text).split(/\r?\n/)

const append = (outcome: Outcome | undefined, line: string) => {
  if (!outcome || (outcome.message?.length ?? 0) > MAX_MESSAGE) return
  outcome.message = outcome.message === undefined ? line : `${outcome.message}\n${line}`
}

const duration = (text: string | undefined) => {
  const hit = /([\d.]+)\s*(ms|s|m)?/.exec(text ?? '')
  if (!hit) return undefined
  const value = Number(hit[1])

  return hit[2] === 's' ? value * 1000 : hit[2] === 'm' ? value * 60000 : value
}

const unknown = (name: string, group: string): TestCase => ({ name, group, status: 'unknown' })

export const dotnetGroup = (name: string) => {
  const base = name.split('(')[0] ?? name
  const dot = base.lastIndexOf('.')

  return dot > 0 ? base.slice(0, dot) : ''
}

export const parseDotnetList = (out: string): TestCase[] => {
  const all = lines(out)
  const start = all.findIndex(l => l.includes('The following Tests are available'))
  if (start < 0) return []

  return all
    .slice(start + 1)
    .map(l => l.trim())
    .filter(Boolean)
    .map(name => unknown(name, dotnetGroup(name)))
}

const DOTNET_STATUS: Record<string, Status> = { Passed: 'passed', Failed: 'failed', Skipped: 'skipped' }

export const parseDotnetRun = (out: string): Outcome[] => {
  const outcomes: Outcome[] = []
  let current: Outcome | undefined
  let isDetail = false
  for (const line of lines(out)) {
    const hit = /^\s+(Passed|Failed|Skipped)\s+(.+?)\s+\[([^\]]+)\]\s*$/.exec(line)
    if (hit) {
      current = { name: hit[2]!, status: DOTNET_STATUS[hit[1]!]!, ms: duration(hit[3]) }
      outcomes.push(current)
      isDetail = false
    } else if (/^\s+(Error Message|Stack Trace):\s*$/.test(line)) {
      isDetail = true
      if (line.includes('Stack Trace')) append(current, 'Stack trace:')
    } else if (line.trim() === '') {
      isDetail = false
    } else if (isDetail) {
      append(current, line.trim())
    }
  }

  return outcomes
}

const pytestGroup = (nodeId: string) => nodeId.slice(0, Math.max(0, nodeId.lastIndexOf('::')))

export const parsePytestList = (out: string): TestCase[] => {
  const tests: TestCase[] = []
  for (const line of lines(out)) {
    if (line.trim() === '') break
    if (line.includes('::')) tests.push(unknown(line.trim(), pytestGroup(line.trim())))
  }

  return tests
}

const PYTEST_STATUS: Record<string, Status> = {
  PASSED: 'passed',
  FAILED: 'failed',
  ERROR: 'failed',
  XFAIL: 'skipped',
  XPASS: 'passed',
}

export const parsePytestRun = (out: string): Outcome[] => {
  const outcomes: Outcome[] = []
  const details = new Map<string, string[]>()
  let block: string[] | undefined
  for (const line of lines(out)) {
    const header = /^_{3,} (.+?) _{3,}$/.exec(line)
    if (header) {
      block = []
      details.set(header[1]!.replace(/^ERROR (at \w+ of )?/, ''), block)
      continue
    }
    if (/^={3,}/.test(line)) block = undefined
    block?.push(line)
    const hit = /^(PASSED|FAILED|ERROR|XFAIL|XPASS) (\S+::\S+)/.exec(line)
    if (hit) outcomes.push({ name: hit[2]!, group: pytestGroup(hit[2]!), status: PYTEST_STATUS[hit[1]!]! })
  }
  for (const outcome of outcomes) {
    const dotted = outcome.name.split('::').slice(1).join('.')
    const detail = [...details].find(([title]) => dotted === title || dotted.endsWith(`.${title}`))?.[1]
    if (detail) outcome.message = detail.join('\n').slice(0, MAX_MESSAGE)
  }

  return outcomes
}

const relative = (dir: string, file: string) => {
  const f = file.replace(/\\/g, '/')
  const d = dir.replace(/\\/g, '/')

  return f.toLowerCase().startsWith(`${d.toLowerCase()}/`) ? f.slice(d.length + 1) : f
}

const json = (out: string, open: string, close: string) => {
  const start = out.indexOf(open)
  const end = out.lastIndexOf(close)

  return start < 0 || end < start ? undefined : (JSON.parse(out.slice(start, end + 1)) as unknown)
}

export const parseVitestList = (out: string, dir: string): TestCase[] => {
  const list = json(out, '[', ']') as { name: string; file: string }[] | undefined

  return (list ?? []).map(t => unknown(t.name, relative(dir, t.file)))
}

type VitestReport = {
  testResults?: {
    name: string
    message?: string
    assertionResults?: {
      title: string
      ancestorTitles?: string[]
      status: string
      duration?: number | null
      failureMessages?: string[]
    }[]
  }[]
}

const VITEST_STATUS: Record<string, Status> = { passed: 'passed', failed: 'failed' }

export const parseVitestRun = (out: string, dir: string): Outcome[] => {
  const report = json(out, '{', '}') as VitestReport | undefined

  return (report?.testResults ?? []).flatMap(file =>
    (file.assertionResults ?? []).map(t => ({
      name: [...(t.ancestorTitles ?? []), t.title].join(' > '),
      group: relative(dir, file.name),
      status: VITEST_STATUS[t.status] ?? 'skipped',
      ms: t.duration ?? undefined,
      message: t.failureMessages?.length ? plain(t.failureMessages.join('\n')).slice(0, MAX_MESSAGE) : undefined,
    })),
  )
}

export const parsePluginTestSource = (source: string, file: string): TestCase[] =>
  [...source.matchAll(/\btest(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map(m => unknown(m[2]!, file))

const PLUGIN_STATUS: Record<string, Status> = { pass: 'passed', fail: 'failed', skip: 'skipped', todo: 'skipped' }

export const parsePluginTestRun = (out: string): Outcome[] => {
  const outcomes: Outcome[] = []
  let group: string | undefined
  let current: Outcome | undefined
  for (const line of lines(out)) {
    const file = /^(\S.*\.test\.[cm]?[jt]sx?):$/.exec(line)
    const hit = /^\((pass|fail|skip|todo)\) (.+?)(?: \[([\d.]+)ms\])?$/.exec(line)
    if (file) {
      group = file[1]!.split(/[\\/]/).pop()
      current = undefined
    } else if (hit) {
      current = { name: hit[2]!, group, status: PLUGIN_STATUS[hit[1]!]!, ms: duration(hit[3]) }
      outcomes.push(current)
    } else if (current?.status === 'failed' && /^\s/.test(line) && line.trim() !== '') {
      append(current, line.trim())
    } else if (line.trim() === '') {
      current = undefined
    }
  }

  return outcomes
}

export const merge = (tests: readonly TestCase[], outcomes: readonly Outcome[]): TestCase[] => {
  const merged: TestCase[] = tests.map(t => ({ ...t, status: 'unknown', ms: undefined, message: undefined }))
  for (const o of outcomes) {
    const same = (t: TestCase) => o.group === undefined || t.group === o.group
    const index = [
      merged.findIndex(t => t.name === o.name && same(t)),
      merged.findIndex(t => t.name.endsWith(`.${o.name}`) && same(t)),
    ].find(i => i >= 0)
    const result = { status: o.status, ms: o.ms, message: o.message }
    if (index === undefined) merged.push({ name: o.name, group: o.group ?? '', ...result })
    else merged[index] = { ...merged[index]!, ...result }
  }

  return merged
}
