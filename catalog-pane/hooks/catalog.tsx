import { atom, read, update } from 'claude-code'
import type {
  CommandInfo,
  Elements,
  EngineInterface,
  FsEntry,
  On,
  ToolInfo,
} from 'claude-code'

import type { Entry, Kind, KnownAgent, Mark, Sort, Usage } from '../types'

export const KINDS: readonly { kind: Kind; label: string; noun: string }[] = [
  { kind: 'skill', label: 'Skills', noun: 'skill' },
  { kind: 'command', label: 'Commands', noun: 'slash command' },
  { kind: 'agent', label: 'Agents', noun: 'subagent type' },
  { kind: 'plugin', label: 'Plugins', noun: 'plugin' },
  { kind: 'mcp', label: 'MCP', noun: 'MCP server' },
  { kind: 'tool', label: 'Tools', noun: 'built-in tool' },
]

export const EVERYWHERE = '*'

const USAGE_KEY = 'usage'
const SKILLS_KEY = 'skills'
const AGENTS_KEY = 'agents'
const EXPLANATIONS_KEY = 'explanations'
const FLUSH_MS = 10_000
const MCP_PREVIEW = 8

const entries = atom({ plugin: 'catalog-pane', key: 'entries' } as const, [])
const isLoading = atom({ plugin: 'catalog-pane', key: 'isLoading' } as const, false)
const usage = atom({ plugin: 'catalog-pane', key: 'usage' } as const, {})
const pending = atom({ plugin: 'catalog-pane', key: 'pending' } as const, {})
const explanations = atom({ plugin: 'catalog-pane', key: 'explanations' } as const, {})
const explaining = atom({ plugin: 'catalog-pane', key: 'explaining' } as const, [])

type Installed = {
  plugins?: Record<string, { installPath: string; version?: string }[]>
}

type PluginDir = {
  name: string
  marketplace: string
  root: string
  version?: string
  isEnabled: boolean
}

export type DetailTags = Pick<
  Elements['terminal'],
  'Box' | 'Text' | 'Button' | 'Markdown'
>

export type DetailProps = {
  entry: Entry
  list: readonly Entry[]
  totals: Usage
  explanation: string | undefined
  isExplaining: boolean
  onOpen: (id: string) => void
  onExplain: () => void
}

export const idOf = (kind: Kind, name: string) => `${kind}:${name}`

export const labelOf = (kind: Kind) =>
  KINDS.find(one => one.kind === kind)?.label ?? kind

const nounOf = (kind: Kind) => KINDS.find(one => one.kind === kind)?.noun ?? kind

export const explanationKey = (language: string, id: string) => `${language}|${id}`

const addMark = (marks: Usage, id: string, mark: Mark): Usage => {
  const seen = marks[id]

  return {
    ...marks,
    [id]: {
      count: (seen?.count ?? 0) + mark.count,
      lastAt: Math.max(seen?.lastAt ?? 0, mark.lastAt),
    },
  }
}

export const merge = (base: Usage, extra: Usage): Usage =>
  Object.entries(extra).reduce((all, [id, mark]) => addMark(all, id, mark), base)

const subtract = (marks: Usage, flushed: Usage): Usage => {
  const left: Usage = {}

  for (const [id, mark] of Object.entries(marks)) {
    const count = mark.count - (flushed[id]?.count ?? 0)

    if (count > 0) {
      left[id] = { count, lastAt: mark.lastAt }
    }
  }

  return left
}

export const usageOf = (entry: Entry, list: readonly Entry[], totals: Usage) => {
  if (entry.kind !== 'plugin') {
    return totals[entry.id] ?? { count: 0, lastAt: 0 }
  }

  return list
    .filter(one => one.kind !== 'plugin' && one.origin === entry.name)
    .reduce<Mark>(
      (sum, one) => {
        const mark = totals[one.id]

        return mark === undefined
          ? sum
          : { count: sum.count + mark.count, lastAt: Math.max(sum.lastAt, mark.lastAt) }
      },
      { count: 0, lastAt: 0 },
    )
}

export const visible = (
  list: readonly Entry[],
  totals: Usage,
  filter: { kind: Kind; query: string; origin: string; sort: Sort },
) => {
  const query = filter.query.trim().toLowerCase()
  const count = (one: Entry) => usageOf(one, list, totals).count

  return list
    .filter(one => one.kind === filter.kind)
    .filter(one => filter.origin === EVERYWHERE || one.origin === filter.origin)
    .filter(
      one =>
        query === '' ||
        one.name.toLowerCase().includes(query) ||
        one.description.toLowerCase().includes(query),
    )
    .sort((a, b) =>
      filter.sort === 'usage' && count(a) !== count(b)
        ? count(b) - count(a)
        : a.name.localeCompare(b.name),
    )
}

export const originsOf = (list: readonly Entry[], kind: Kind) =>
  [...new Set(list.filter(one => one.kind === kind).map(one => one.origin))].sort()

export const firstLine = (text: string) => text.split(/\r?\n/).find(line => line.trim() !== '') ?? ''

export const usageText = (mark: Mark) =>
  mark.count === 0
    ? 'never used'
    : `${mark.count}× · last ${new Date(mark.lastAt).toISOString().slice(0, 10)}`

const firstParagraph = (text: string) => text.trim().split(/\r?\n\s*\r?\n/)[0] ?? ''

const frontmatter = (text: string) => {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*(.*)$`, 'm')
      .exec(head)?.[1]
      ?.trim()
      .replace(/^(["'])(.*)\1$/, '$2')
      .replaceAll('\\n', '\n')

  return { name: field('name'), description: field('description') }
}

async function configDir($: EngineInterface) {
  const own = await $.env.get('CLAUDE_CONFIG_DIR')

  if (own !== undefined && own !== '') {
    return own
  }

  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''

  return `${home}/.claude`
}

async function readJson<T>($: EngineInterface, path: string) {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

async function namesIn(
  $: EngineInterface,
  dir: string,
  isWanted: (entry: FsEntry) => boolean,
) {
  const entries = await $.fs.list(dir).catch(() => [] as FsEntry[])

  return entries.filter(isWanted).map(entry => entry.name)
}

const isFolder = (entry: FsEntry) => entry.kind === 'dir' || entry.isLink

const isMarkdown = (entry: FsEntry) => entry.kind !== 'dir' && entry.name.endsWith('.md')

async function agentsIn(
  $: EngineInterface,
  dir: string,
  source: string,
  prefix?: string,
): Promise<KnownAgent[]> {
  const files = await namesIn($, dir, isMarkdown)

  return Promise.all(
    files.map(async file => {
      const text = await $.fs.read(`${dir}/${file}`).catch(() => '')
      const { name = file.replace(/\.md$/, ''), description = '' } = frontmatter(text)

      return { name: prefix === undefined ? name : `${prefix}:${name}`, description, source }
    }),
  )
}

async function pluginDirs($: EngineInterface, config: string): Promise<PluginDir[]> {
  const installed = await readJson<Installed>($, `${config}/plugins/installed_plugins.json`)
  const settings = await $.settings.read()
  const enabled = (settings.enabledPlugins ?? {}) as Record<string, unknown>

  return Object.entries(installed?.plugins ?? {}).flatMap(([key, installs]) => {
    const [name = key, marketplace = ''] = key.split('@')
    const first = installs[0]

    return first === undefined
      ? []
      : [
          {
            name,
            marketplace,
            root: first.installPath,
            version: first.version,
            isEnabled: enabled[key] === true,
          },
        ]
  })
}

const agentOrigin = (agent: KnownAgent) => {
  const prefix = agent.name.includes(':') ? agent.name.split(':')[0] : undefined

  if (prefix !== undefined) {
    return prefix
  }

  if (agent.source === 'built-in') {
    return 'built-in'
  }

  return /project/i.test(agent.source) ? 'project' : 'user'
}

const commandOrigin = (command: CommandInfo, skillOrigin: string | undefined) => {
  if (command.plugin !== undefined) {
    return command.plugin
  }

  if (skillOrigin !== undefined) {
    return skillOrigin
  }

  return command.source === 'builtin' ? 'built-in' : command.source
}

const mcpEntries = (tools: readonly ToolInfo[]): Entry[] => {
  const servers = new Map<string, string[]>()

  for (const tool of tools) {
    const [, server, name] = tool.name.split('__')

    if (tool.name.startsWith('mcp__') && server !== undefined) {
      servers.set(server, [...(servers.get(server) ?? []), name ?? tool.name])
    }
  }

  return [...servers].map(([server, names]) => ({
    id: idOf('mcp', server),
    kind: 'mcp',
    name: server,
    origin: 'mcp',
    description:
      `${names.length} tools: ${names.slice(0, MCP_PREVIEW).join(', ')}` +
      (names.length > MCP_PREVIEW ? ', …' : ''),
    detail: names.join(', '),
  }))
}

export async function collect($: EngineInterface): Promise<Entry[]> {
  const config = await configDir($)
  const [commands, tools, plugins] = await Promise.all([
    $.command.list(),
    $.tool.list(),
    pluginDirs($, config),
  ])
  const seenSkills = ((await $.store.get(SKILLS_KEY)) ?? []) as string[]
  const offered = ((await $.store.get(AGENTS_KEY)) ?? {}) as Record<string, KnownAgent>

  const skillOrigins = new Map<string, string>()

  for (const name of seenSkills) {
    skillOrigins.set(name, name.includes(':') ? (name.split(':')[0] ?? 'user') : 'user')
  }

  for (const name of await namesIn($, `${config}/skills`, isFolder)) {
    skillOrigins.set(name, 'user')
  }

  for (const name of await namesIn($, '.claude/skills', isFolder)) {
    skillOrigins.set(name, 'project')
  }

  const agents = new Map<string, KnownAgent>()
  const found = [
    ...(await agentsIn($, `${config}/agents`, 'userSettings')),
    ...(await agentsIn($, '.claude/agents', 'projectSettings')),
  ]

  for (const plugin of plugins) {
    for (const name of await namesIn($, `${plugin.root}/skills`, isFolder)) {
      skillOrigins.set(`${plugin.name}:${name}`, plugin.name)
    }

    found.push(...(await agentsIn($, `${plugin.root}/agents`, 'plugin', plugin.name)))
  }

  for (const agent of [...found, ...Object.values(offered)]) {
    agents.set(agent.name, agent)
  }

  const commandEntries: Entry[] = commands.map(command => {
    const skillOrigin = skillOrigins.get(command.name)
    const kind: Kind = skillOrigin === undefined ? 'command' : 'skill'

    return {
      id: idOf(kind, command.name),
      kind,
      name: command.name,
      description: command.description,
      origin: commandOrigin(command, skillOrigin),
    }
  })

  const loaded = new Set(commands.flatMap(command => command.plugin ?? []))
  const pluginEntries: Entry[] = await Promise.all(
    plugins.map(async plugin => {
      const manifest = await readJson<{ description?: string }>(
        $,
        `${plugin.root}/.claude-plugin/plugin.json`,
      )
      loaded.delete(plugin.name)

      return {
        id: idOf('plugin', plugin.name),
        kind: 'plugin' as const,
        name: plugin.name,
        description: manifest?.description ?? '',
        origin: plugin.marketplace,
        detail: [
          plugin.version === undefined ? undefined : `v${plugin.version}`,
          plugin.isEnabled ? 'enabled' : 'disabled',
        ]
          .filter(Boolean)
          .join(' · '),
      }
    }),
  )

  for (const name of loaded) {
    pluginEntries.push({
      id: idOf('plugin', name),
      kind: 'plugin',
      name,
      description: '',
      origin: 'session',
      detail: 'loaded in this session',
    })
  }

  const agentEntries: Entry[] = [...agents.values()].map(agent => ({
    id: idOf('agent', agent.name),
    kind: 'agent',
    name: agent.name,
    description: agent.description,
    origin: agentOrigin(agent),
  }))

  const toolEntries: Entry[] = tools
    .filter(tool => !tool.name.startsWith('mcp__'))
    .map(tool => ({
      id: idOf('tool', tool.name),
      kind: 'tool',
      name: tool.name,
      description: firstParagraph(tool.description),
      origin: 'built-in',
    }))

  return [
    ...commandEntries,
    ...agentEntries,
    ...pluginEntries,
    ...mcpEntries(tools),
    ...toolEntries,
  ]
}

const skillName = (skill: string, pluginName: string | undefined) =>
  pluginName === undefined || skill.includes(':') ? skill : `${pluginName}:${skill}`

let isFlushing = false
let skills = new Set<string>()
let agents: Record<string, KnownAgent> = {}

async function bump($: EngineInterface, id: string) {
  const at = await $.clock.now()
  await update($, pending, marks => addMark(marks, id, { count: 1, lastAt: at }))
}

async function flush($: EngineInterface) {
  if (isFlushing) {
    return
  }

  isFlushing = true

  try {
    const delta = await read($, pending)

    if (Object.keys(delta).length > 0) {
      // Re-read the store so counts from other sessions running at the same time survive.
      const merged = merge(((await $.store.get(USAGE_KEY)) ?? {}) as Usage, delta)
      await $.store.set(USAGE_KEY, merged)
      await update($, pending, marks => subtract(marks, delta))
      await update($, usage, () => merged)
    }
  } finally {
    isFlushing = false
  }
}

export async function snapshot($: EngineInterface) {
  return {
    list: await read($, entries),
    totals: merge(await read($, usage), await read($, pending)),
    notes: await read($, explanations),
    busy: await read($, explaining),
    isLoading: await read($, isLoading),
  }
}

export async function refresh($: EngineInterface) {
  await update($, isLoading, () => true)

  try {
    const list = await collect($)
    await update($, entries, () => list)
  } finally {
    await update($, isLoading, () => false)
  }
}

export async function startCatalog($: EngineInterface) {
  const stored = ((await $.store.get(USAGE_KEY)) ?? {}) as Usage
  const known = ((await $.store.get(EXPLANATIONS_KEY)) ?? {}) as Record<string, string>
  skills = new Set(((await $.store.get(SKILLS_KEY)) ?? []) as string[])
  agents = ((await $.store.get(AGENTS_KEY)) ?? {}) as Record<string, KnownAgent>
  await update($, usage, () => stored)
  await update($, explanations, () => known)
  $.clock.every(FLUSH_MS, () => void flush($))
}

export function trackCatalog(on: On) {
  on('session.end', async ($, e, next) => {
    await flush($)

    return next(e)
  })

  on('command.run', async ($, e, next) => {
    await bump($, idOf('command', e.command))

    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    const name = skillName(e.skill, e.pluginName)
    await bump($, idOf('skill', name))

    if (!skills.has(name)) {
      skills.add(name)
      await $.store.set(SKILLS_KEY, [...skills])
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    await bump($, idOf('agent', e.subagentType || 'general-purpose'))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const [, server] = tool.split('__')
    await bump(
      $,
      tool.startsWith('mcp__') && server !== undefined ? idOf('mcp', server) : idOf('tool', tool),
    )

    return next(e)
  })

  on('agent.offer', async ($, e, next) => {
    const seen = agents[e.agent]

    if (seen?.description !== e.description || seen.source !== e.source) {
      agents = { ...agents, [e.agent]: { name: e.agent, description: e.description, source: e.source } }
      await $.store.set(AGENTS_KEY, agents)
    }

    return next(e)
  })
}

async function explain($: EngineInterface, entry: Entry, language: string) {
  const result = await $.model.complete({
    model: 'haiku',
    maxTokens: 400,
    system: 'You explain one part of a Claude Code setup to its user. Be concrete and brief.',
    prompt: [
      `Kind: ${nounOf(entry.kind)}`,
      `Name: ${entry.name}`,
      `From: ${entry.origin}`,
      `Description: ${entry.description || '(none)'}`,
      entry.detail === undefined ? '' : `Details: ${entry.detail}`,
      '',
      `Answer in ${language}, in at most three short sentences and without a preamble: ` +
        'what it is good for, when to reach for it, and one concrete example of using it.',
    ].join('\n'),
  })

  return result.isAnswered ? result.text.trim() : undefined
}

export async function explainInto(
  $: EngineInterface,
  entry: Entry,
  language: string,
) {
  await update($, explaining, ids => [...ids, entry.id])

  try {
    const text = await explain($, entry, language)

    if (text === undefined) {
      $.ui.toast(`No explanation for ${entry.name}: the model did not answer.`)

      return
    }

    const key = explanationKey(language, entry.id)
    const stored = ((await $.store.get(EXPLANATIONS_KEY)) ?? {}) as Record<string, string>
    await $.store.set(EXPLANATIONS_KEY, { ...stored, [key]: text })
    await update($, explanations, all => ({ ...all, [key]: text }))
  } finally {
    await update($, explaining, ids => ids.filter(id => id !== entry.id))
  }
}

function insert($: EngineInterface, text: string) {
  void $.prompt.fill({ text, mode: 'replace' })
}

async function run($: EngineInterface, name: string) {
  try {
    await $.command.run({ command: name })
  } catch {
    $.ui.toast(`/${name} could not run here; inserted it into the prompt instead.`)
    insert($, `/${name} `)
  }
}

function actions($: EngineInterface, { Box, Button }: DetailTags, entry: Entry) {
  if (entry.kind === 'skill' || entry.kind === 'command') {
    return (
      <Box flexDirection="row" gap={1}>
        <Button key="run" label={`Run /${entry.name}`} variant="primary" onPress={() => run($, entry.name)} />
        <Button key="insert" label="Insert into prompt" onPress={() => insert($, `/${entry.name} `)} />
      </Box>
    )
  }

  const prompts: Partial<Record<Kind, string>> = {
    agent: `Use the ${entry.name} agent to `,
    mcp: `Use the ${entry.name} MCP server to `,
    tool: `Use the ${entry.name} tool to `,
  }
  const prompt = prompts[entry.kind]

  return prompt === undefined ? undefined : (
    <Box flexDirection="row">
      <Button key="insert" label="Insert into prompt" variant="primary" onPress={() => insert($, prompt)} />
    </Box>
  )
}

export function detail($: EngineInterface, tags: DetailTags, props: DetailProps) {
  const { Box, Text, Button, Markdown } = tags
  const { entry, list, totals } = props
  const items = entry.kind === 'plugin' ? list.filter(one => one.kind !== 'plugin' && one.origin === entry.name) : []
  const facts = [
    `${labelOf(entry.kind)} from ${entry.origin}`,
    entry.kind === 'mcp' ? undefined : entry.detail,
    usageText(usageOf(entry, list, totals)),
  ].filter(Boolean)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold size="heading">
          {entry.name}
        </Text>
        <Text dimColor>{facts.join(' · ')}</Text>
      </Box>
      <Markdown key="about" text={entry.description || '_No description._'} />
      {entry.kind === 'mcp' && entry.detail !== undefined && <Text dimColor>Tools: {entry.detail}</Text>}
      <Box flexDirection="column">
        <Text bold>What it is for</Text>
        {props.explanation === undefined ? (
          <Box flexDirection="row">
            <Button
              key="explain"
              label={props.isExplaining ? 'Asking Haiku…' : 'Explain with Haiku'}
              onPress={props.isExplaining ? () => undefined : props.onExplain}
            />
          </Box>
        ) : (
          <Markdown key="why" text={props.explanation} />
        )}
      </Box>
      {actions($, tags, entry)}
      {items.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Provides</Text>
          {items.map(one => (
            <Button key={`item-${one.id}`} plain onPress={() => props.onOpen(one.id)}>
              {one.name} <Text dimColor>{labelOf(one.kind)}</Text>
            </Button>
          ))}
        </Box>
      )}
    </Box>
  )
}
