import { atom, read, update } from 'claude-code'
import type {
  CommandInfo,
  Elements,
  EngineInterface,
  FsEntry,
  On,
  Register,
  ToolInfo,
} from 'claude-code'

import type {
  Cost,
  Daily,
  Entry,
  Kind,
  KnownAgent,
  Mark,
  PluginInfo,
  RepoStats,
  Scan,
  Sort,
  Stat,
  Usage,
  View,
} from '../types'

const KINDS: readonly { kind: Kind; label: string; noun: string }[] = [
  { kind: 'skill', label: 'Skills', noun: 'skill' },
  { kind: 'command', label: 'Commands', noun: 'slash command' },
  { kind: 'agent', label: 'Agents', noun: 'subagent type' },
  { kind: 'mod', label: 'Mods', noun: 'mod (a plugin with function hooks)' },
  { kind: 'plugin', label: 'Plugins', noun: 'plugin' },
  { kind: 'hook', label: 'Hooks', noun: 'settings hook (a shell command run on an event)' },
  { kind: 'mcp', label: 'MCP', noun: 'MCP server' },
  { kind: 'tool', label: 'Tools', noun: 'built-in tool' },
]

const EVERYWHERE = '*'

const USAGE_KEY = 'usage'
const DAILY_KEY = 'daily'
const COSTS_KEY = 'costs'
const REPOS_KEY = 'repos'
const SCANS_KEY = 'scans'
const SKILLS_KEY = 'skills'
const AGENTS_KEY = 'agents'
const EXPLANATIONS_KEY = 'explanations'
const FLUSH_MS = 10_000
const DAY_MS = 86_400_000
const KEPT_DAYS = 31
const REPO_TTL_MS = DAY_MS
const KEPT_STAR_POINTS = 120
const MONTH_DAYS = 30
const CLI_TIMEOUT_MS = 120_000
const MCP_PREVIEW = 8

const entries = atom({ plugin: 'catalog-pane', key: 'entries' } as const, [])
const isLoading = atom({ plugin: 'catalog-pane', key: 'isLoading' } as const, false)
const usage = atom({ plugin: 'catalog-pane', key: 'usage' } as const, {})
const pending = atom({ plugin: 'catalog-pane', key: 'pending' } as const, {})
const daily = atom({ plugin: 'catalog-pane', key: 'daily' } as const, {})
const costs = atom({ plugin: 'catalog-pane', key: 'costs' } as const, {})
const repos = atom({ plugin: 'catalog-pane', key: 'repos' } as const, {})
const scans = atom({ plugin: 'catalog-pane', key: 'scans' } as const, {})
const explanations = atom({ plugin: 'catalog-pane', key: 'explanations' } as const, {})
const explaining = atom({ plugin: 'catalog-pane', key: 'explaining' } as const, [])
const confirming = atom({ plugin: 'catalog-pane', key: 'confirming' } as const, null)
const working = atom({ plugin: 'catalog-pane', key: 'working' } as const, null)

type Installed = {
  plugins?: Record<
    string,
    { installPath: string; version?: string; installedAt?: string; lastUpdated?: string }[]
  >
}

type Marketplaces = Record<
  string,
  { source?: { source?: string; repo?: string }; installLocation?: string }
>

type MarketplaceFile = {
  plugins?: { name: string; version?: string; source?: unknown }[]
}

type Manifest = { name?: string; description?: string; version?: string; repository?: unknown }

type HookGroups = Record<string, { matcher?: string; hooks?: { type?: string; command?: string }[] }[]>

type HooksFile = { modules?: string[]; hooks?: HookGroups }

type PluginDir = { name: string; root: string; info: PluginInfo }

const SETTINGS_SOURCES = ['user', 'project', 'local', 'policy'] as const

type MeasuredPlugin = { total: Cost; parts: Record<string, Cost> }

type DetailTags = Pick<
  Elements['terminal'],
  'Box' | 'Text' | 'Button' | 'Markdown' | 'Link'
>

type DetailProps = {
  entry: Entry
  list: readonly Entry[]
  stats: Record<string, Stat>
  repos: Record<string, RepoStats>
  scans: Record<string, Scan>
  now: number
  confirming: string | null
  working: string | null
  explanation: string | undefined
  isExplaining: boolean
  onOpen: (id: string) => void
  onExplain: () => void
}

let isFlushing = false
let skills = new Set<string>()
let agents: Record<string, KnownAgent> = {}
let showsGithub = true
let enriching: Promise<void> = Promise.resolve()

const idOf = (kind: Kind, name: string) => `${kind}:${name}`

const labelOf = (kind: Kind) =>
  KINDS.find(one => one.kind === kind)?.label ?? kind

const nounOf = (kind: Kind) => KINDS.find(one => one.kind === kind)?.noun ?? kind

const explanationKey = (language: string, id: string) => `${language}|${id}`

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)

const dateOf = (value: string | number) => new Date(value).toISOString().slice(0, 10)

const shortNumber = (count: number) =>
  count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${count}`

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

const merge = (base: Usage, extra: Usage): Usage =>
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

const addDay = (days: Daily, day: string, delta: Usage, now: number): Daily => {
  const oldest = dayOf(now - KEPT_DAYS * DAY_MS)
  const kept: Daily = Object.fromEntries(Object.entries(days).filter(([one]) => one >= oldest))
  const counts = { ...(kept[day] ?? {}) }

  for (const [id, mark] of Object.entries(delta)) {
    counts[id] = (counts[id] ?? 0) + mark.count
  }

  return { ...kept, [day]: counts }
}

const sinceDays = (days: Daily, id: string, span: number, now: number) => {
  const oldest = dayOf(now - (span - 1) * DAY_MS)

  return Object.entries(days)
    .filter(([day]) => day >= oldest)
    .reduce((sum, [, counts]) => sum + (counts[id] ?? 0), 0)
}

const statsOf = (
  list: readonly Entry[],
  totals: Usage,
  waiting: Usage,
  days: Daily,
  measured: Record<string, Cost>,
  now: number,
): Record<string, Stat> => {
  const stats: Record<string, Stat> = {}

  for (const one of list.filter(entry => !isContainer(entry.kind))) {
    const mark = totals[one.id] ?? { count: 0, lastAt: 0 }
    const fresh = waiting[one.id]?.count ?? 0
    stats[one.id] = {
      ...mark,
      week: sinceDays(days, one.id, 7, now) + fresh,
      month: sinceDays(days, one.id, 30, now) + fresh,
      cost: measured[one.id],
    }
  }

  for (const one of list.filter(entry => isContainer(entry.kind))) {
    const items = list.filter(item => !isContainer(item.kind) && item.origin === one.name)
    stats[one.id] = items.reduce<Stat>(
      (sum, item) => {
        const stat = stats[item.id]

        return stat === undefined
          ? sum
          : {
              ...sum,
              count: sum.count + stat.count,
              lastAt: Math.max(sum.lastAt, stat.lastAt),
              week: sum.week + stat.week,
              month: sum.month + stat.month,
            }
      },
      { count: 0, lastAt: 0, week: 0, month: 0, cost: measured[one.id] },
    )
  }

  return stats
}

const isContainer = (kind: Kind) => kind === 'plugin' || kind === 'mod'

const statOf = (stats: Record<string, Stat>, id: string): Stat =>
  stats[id] ?? { count: 0, lastAt: 0, week: 0, month: 0 }

const ownerOf = (entry: Entry, list: readonly Entry[]) =>
  entry.plugin === undefined ? list.find(one => isContainer(one.kind) && one.name === entry.origin) : entry

const infoOf = (entry: Entry, list: readonly Entry[]) => ownerOf(entry, list)?.plugin

const repoOf = (entry: Entry, list: readonly Entry[], known: Record<string, RepoStats>) => {
  const repo = infoOf(entry, list)?.repo

  return repo === undefined ? undefined : known[repo]
}

// Stars gained per month: measured from the stored history once it spans a day, else averaged over the repo's age.
const trendOf = (repo: RepoStats, now: number) => {
  const oldest = dayOf(now - MONTH_DAYS * DAY_MS)
  const base = [...(repo.history ?? [])].reverse().find(point => point.day <= oldest) ?? (repo.history ?? [])[0]
  const span = base === undefined ? 0 : (now - Date.parse(base.day)) / DAY_MS

  if (base !== undefined && span >= 1) {
    return { perMonth: ((repo.stars - base.stars) / span) * MONTH_DAYS, isMeasured: true }
  }

  const months = Math.max(1, (now - Date.parse(repo.createdAt || '1970-01-01')) / DAY_MS / MONTH_DAYS)

  return { perMonth: repo.stars / months, isMeasured: false }
}

const timeOf = (value: string | undefined) => {
  const at = value === undefined ? Number.NaN : Date.parse(value)

  return Number.isNaN(at) ? undefined : at
}

const SORTS: readonly { sort: Sort; label: string }[] = [
  { sort: 'usage', label: 'Most used' },
  { sort: 'recent', label: 'Recently used' },
  { sort: 'name', label: 'Name' },
  { sort: 'cleanup', label: 'Clean-up: costly and unused first' },
  { sort: 'stars', label: 'GitHub stars' },
  { sort: 'trending', label: 'Trending: stars gained per month' },
  { sort: 'forks', label: 'GitHub forks' },
  { sort: 'pushed', label: 'Latest GitHub push' },
  { sort: 'installs', label: 'Installs in the official directory' },
  { sort: 'installed', label: 'Newest installed' },
]

const metricOf = (
  sort: Sort,
  entry: Entry,
  list: readonly Entry[],
  stat: Stat,
  known: Record<string, RepoStats>,
  now: number,
) => {
  const repo = repoOf(entry, list, known)
  const info = infoOf(entry, list)

  switch (sort) {
    case 'recent':
      return stat.lastAt === 0 ? undefined : stat.lastAt
    case 'stars':
      return repo?.stars
    case 'trending':
      return repo === undefined ? undefined : trendOf(repo, now).perMonth
    case 'forks':
      return repo?.forks
    case 'pushed':
      return timeOf(repo?.pushedAt)
    case 'installs':
      return info?.installs
    case 'installed':
      return timeOf(info?.installedAt)
    default:
      return undefined
  }
}

// What the active sort ranks by, for the row; undefined where the row already says it.
const metricText = (
  sort: Sort,
  entry: Entry,
  list: readonly Entry[],
  stat: Stat,
  known: Record<string, RepoStats>,
  now: number,
) => {
  const repo = repoOf(entry, list, known)
  const info = infoOf(entry, list)

  switch (sort) {
    case 'trending':
      return repo === undefined ? undefined : trendText(repo, now)
    case 'forks':
      return repo === undefined ? undefined : `${shortNumber(repo.forks)} forks`
    case 'pushed':
      return repo === undefined || repo.pushedAt === '' ? undefined : `pushed ${dateOf(repo.pushedAt)}`
    case 'installs':
      return info?.installs === undefined ? undefined : `${shortNumber(info.installs)} installs`
    case 'installed':
      return info?.installedAt === undefined ? undefined : `installed ${dateOf(info.installedAt)}`
    case 'recent':
      return stat.lastAt === 0 ? undefined : `last ${dateOf(stat.lastAt)}`
    case 'stars':
      return entry.plugin === undefined && repo !== undefined ? `★ ${shortNumber(repo.stars)}` : undefined
    default:
      return undefined
  }
}

const visible = (
  list: readonly Entry[],
  stats: Record<string, Stat>,
  filter: { kind: Kind; query: string; origin: string; sort: Sort },
  known: Record<string, RepoStats> = {},
  now = 0,
) => {
  const query = filter.query.trim().toLowerCase()
  const order = (a: Entry, b: Entry) => {
    const one = statOf(stats, a.id)
    const two = statOf(stats, b.id)
    const first = metricOf(filter.sort, a, list, one, known, now)
    const second = metricOf(filter.sort, b, list, two, known, now)

    if (first !== second) {
      if (first === undefined || second === undefined) {
        return first === undefined ? 1 : -1
      }

      return second - first
    }

    if (filter.sort === 'usage' && one.count !== two.count) {
      return two.count - one.count
    }

    if (filter.sort === 'cleanup') {
      const unused = Number(two.month === 0) - Number(one.month === 0)
      const weight = (two.cost?.alwaysOn ?? 0) - (one.cost?.alwaysOn ?? 0)

      if (unused !== 0 || weight !== 0 || one.count !== two.count) {
        return unused || weight || one.count - two.count
      }
    }

    return a.name.localeCompare(b.name)
  }

  return list
    .filter(one => one.kind === filter.kind)
    .filter(one => filter.origin === EVERYWHERE || one.origin === filter.origin)
    .filter(
      one =>
        query === '' ||
        one.name.toLowerCase().includes(query) ||
        one.description.toLowerCase().includes(query),
    )
    .sort(order)
}

const originsOf = (list: readonly Entry[], kind: Kind) =>
  [...new Set(list.filter(one => one.kind === kind).map(one => one.origin))].sort()

const firstLine = (text: string) => text.split(/\r?\n/).find(line => line.trim() !== '') ?? ''

const rowText = (entry: Entry, stat: Stat, known: Record<string, RepoStats> = {}) =>
  [
    entry.origin,
    stat.count === 0 ? 'never used' : `${stat.count}× (${stat.month} in 30d)`,
    stat.cost === undefined ? undefined : `~${shortNumber(stat.cost.alwaysOn)} tok/session`,
    entry.plugin?.repo === undefined || known[entry.plugin.repo] === undefined
      ? undefined
      : `★ ${shortNumber(known[entry.plugin.repo]?.stars ?? 0)}`,
    entry.plugin?.latest !== undefined && entry.plugin.latest !== entry.plugin.version ? 'update' : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

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

const githubRepo = (value: unknown) => {
  const url =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null && 'url' in value
        ? String(value.url)
        : ''
  const match = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(url)

  return match === null ? undefined : `${match[1]}/${match[2]}`
}

const sourceRepo = (source: unknown) =>
  typeof source === 'object' && source !== null && 'repo' in source && typeof source.repo === 'string'
    ? source.repo
    : undefined

const tokenCount = (text: string) => {
  const match = /^~?([\d.,]+)(k?)$/.exec(text.trim())

  if (match === null) {
    return undefined
  }

  const count = Number((match[1] ?? '').replaceAll(',', ''))

  return Math.round(match[2] === 'k' ? count * 1000 : count)
}

const parseDetails = (text: string): MeasuredPlugin => {
  const parts: Record<string, Cost> = {}
  const table = text.split(/Per-component[^\n]*\n/)[1] ?? ''

  for (const line of table.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(line)
    const alwaysOn = match === null ? undefined : tokenCount(match[2] ?? '')

    if (match?.[1] !== undefined && alwaysOn !== undefined) {
      parts[match[1]] = { alwaysOn, onInvoke: tokenCount(match[3] ?? '') }
    }
  }

  const total = /Always-on:\s+(\S+)\s+tok/.exec(text)?.[1]
  const sum = Object.values(parts).reduce((all, part) => all + part.alwaysOn, 0)

  return { total: { alwaysOn: (total === undefined ? undefined : tokenCount(total)) ?? sum }, parts }
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

async function latestOf($: EngineInterface, marketplace: Marketplaces[string] | undefined, name: string) {
  const location = marketplace?.installLocation

  if (location === undefined) {
    return {}
  }

  const listed = (await readJson<MarketplaceFile>($, `${location}/.claude-plugin/marketplace.json`))?.plugins?.find(
    one => one.name === name,
  )

  if (listed === undefined) {
    return {}
  }

  const local =
    typeof listed.source === 'string'
      ? await readJson<Manifest>($, `${location}/${listed.source}/.claude-plugin/plugin.json`)
      : undefined

  return { version: listed.version ?? local?.version, repo: sourceRepo(listed.source) }
}

async function pluginDirs(
  $: EngineInterface,
  config: string,
): Promise<(PluginDir & { manifest?: Manifest; hooksFile?: HooksFile })[]> {
  const installed = await readJson<Installed>($, `${config}/plugins/installed_plugins.json`)
  const marketplaces = (await readJson<Marketplaces>($, `${config}/plugins/known_marketplaces.json`)) ?? {}
  const catalog = await readJson<{ catalog?: { plugins?: Record<string, { unique_installs?: number }> } }>(
    $,
    `${config}/plugins/plugin-catalog-cache.json`,
  )
  const settings = await $.settings.read()
  const enabled = (settings.enabledPlugins ?? {}) as Record<string, unknown>

  const dirs = await Promise.all(
    Object.entries(installed?.plugins ?? {}).map(async ([key, installs]) => {
      const [name = key, marketplace = ''] = key.split('@')
      const first = installs[0]

      if (first === undefined) {
        return undefined
      }

      const manifest = await readJson<Manifest>($, `${first.installPath}/.claude-plugin/plugin.json`)
      const hooksFile = await readJson<HooksFile>($, `${first.installPath}/hooks/hooks.json`)
      const latest = await latestOf($, marketplaces[marketplace], name)
      const info: PluginInfo = {
        key,
        version: first.version,
        latest: latest.version,
        isEnabled: enabled[key] === true,
        installedAt: first.installedAt,
        updatedAt: first.lastUpdated,
        repo:
          latest.repo ??
          githubRepo(manifest?.repository) ??
          sourceRepo(marketplaces[marketplace]?.source),
        installs: catalog?.catalog?.plugins?.[key]?.unique_installs,
      }

      return { name, root: first.installPath, info, manifest, hooksFile }
    }),
  )

  return dirs.filter(one => one !== undefined)
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

// claude.ai connectors and plugin-provided servers are not managed by `claude mcp`.
const isRemovableServer = (server: string) =>
  !server.startsWith('claude_ai') && !server.startsWith('plugin_') && !/^[0-9a-f]{8}-/.test(server)

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
    isRemovable: isRemovableServer(server),
  }))
}

const isMod = (hooksFile: HooksFile | undefined) => (hooksFile?.modules?.length ?? 0) > 0

const hookEntries = (groups: HookGroups | undefined, origin: string, place: string): Entry[] =>
  Object.entries(groups ?? {}).flatMap(([event, list]) =>
    list.flatMap((group, at) =>
      (group.hooks ?? []).map((hook, index) => ({
        id: idOf('hook', `${origin}:${event}:${at}:${index}`),
        kind: 'hook' as const,
        name: group.matcher === undefined || group.matcher === '' ? event : `${event} · ${group.matcher}`,
        description: hook.command === undefined ? `A ${hook.type ?? 'hook'} hook.` : `\`${hook.command}\``,
        origin,
        detail: `${hook.type ?? 'command'} hook from ${place}`,
      })),
    ),
  )

// CLAUDE_CODE_PLUGIN_DIRS uses the platform's path-list separator.
const folderList = (value: string) =>
  value
    .split(/^[A-Za-z]:[\\/]/.test(value) || value.includes(';') ? ';' : ':')
    .map(one => one.trim())
    .filter(one => one !== '')

async function folderPlugins($: EngineInterface): Promise<Entry[]> {
  const folders = folderList((await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? '')

  const found = await Promise.all(
    folders.map(async root => {
      const manifest = await readJson<Manifest>($, `${root}/.claude-plugin/plugin.json`)

      if (manifest?.name === undefined) {
        return []
      }

      const hooksFile = await readJson<HooksFile>($, `${root}/hooks/hooks.json`)
      const kind: Kind = isMod(hooksFile) ? 'mod' : 'plugin'
      const version = manifest.version === undefined ? '' : `, v${manifest.version}`
      const entry: Entry = {
        id: idOf(kind, manifest.name),
        kind,
        name: manifest.name,
        description: manifest.description ?? '',
        origin: 'folder',
        detail: `Loaded from ${root} through CLAUDE_CODE_PLUGIN_DIRS${version}.`,
        root,
      }

      return [entry, ...hookEntries(hooksFile?.hooks, manifest.name, `the plugin ${manifest.name}`)]
    }),
  )

  return found.flat()
}

async function settingsHooks($: EngineInterface): Promise<Entry[]> {
  const found = await Promise.all(
    SETTINGS_SOURCES.map(async source => {
      const settings = await $.settings.read({ source }).catch(() => ({}) as Record<string, unknown>)

      return hookEntries(settings.hooks as HookGroups | undefined, source, `the ${source} settings`)
    }),
  )

  return found.flat()
}

async function collect($: EngineInterface): Promise<Entry[]> {
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

  const agentsFound = new Map<string, KnownAgent>()
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
    agentsFound.set(agent.name, agent)
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

  const folders = await folderPlugins($)
  const loaded = new Set(commands.flatMap(command => command.plugin ?? []))

  for (const entry of folders) {
    loaded.delete(entry.name)
  }

  const pluginEntries: Entry[] = plugins.map(plugin => {
    const kind: Kind = isMod(plugin.hooksFile) ? 'mod' : 'plugin'
    loaded.delete(plugin.name)

    return {
      id: idOf(kind, plugin.name),
      kind,
      name: plugin.name,
      description: plugin.manifest?.description ?? '',
      origin: plugin.info.key.split('@')[1] ?? '',
      plugin: plugin.info,
      root: plugin.root,
    }
  })

  for (const name of loaded) {
    pluginEntries.push({
      id: idOf('plugin', name),
      kind: 'plugin',
      name,
      description: '',
      origin: 'session',
      detail: 'Loaded for this session from a folder, not installed.',
    })
  }

  const agentEntries: Entry[] = [...agentsFound.values()].map(agent => ({
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

  const pluginHooks = plugins.flatMap(plugin =>
    hookEntries(plugin.hooksFile?.hooks, plugin.name, `the plugin ${plugin.name}`),
  )

  return [
    ...commandEntries,
    ...agentEntries,
    ...pluginEntries,
    ...folders,
    ...pluginHooks,
    ...(await settingsHooks($)),
    ...mcpEntries(tools),
    ...toolEntries,
  ]
}

async function measureCosts($: EngineInterface, list: readonly Entry[]) {
  const cache = ((await $.store.get(COSTS_KEY)) ?? {}) as Record<string, MeasuredPlugin>
  const measured: Record<string, Cost> = {}

  for (const entry of list) {
    const info = entry.plugin

    if (info === undefined) {
      continue
    }

    const cacheKey = `${info.key}@${info.version ?? ''}`
    let result = cache[cacheKey]

    if (result === undefined) {
      const run = await $.process
        .run(['claude', 'plugin', 'details', info.key], { timeoutMs: CLI_TIMEOUT_MS })
        .catch(() => undefined)

      if (run === undefined || run.exitCode !== 0) {
        continue
      }

      result = parseDetails(run.stdout)
      cache[cacheKey] = result
      await $.store.set(COSTS_KEY, cache)
    }

    measured[entry.id] = result.total

    for (const [part, cost] of Object.entries(result.parts)) {
      for (const kind of ['skill', 'agent', 'command'] as const) {
        measured[idOf(kind, `${entry.name}:${part}`)] = cost
      }
    }

    await update($, costs, () => ({ ...measured }))
  }
}

async function fetchRepos($: EngineInterface, list: readonly Entry[]) {
  const cache = ((await $.store.get(REPOS_KEY)) ?? {}) as Record<string, RepoStats>
  const now = await $.clock.now()
  const wanted = [...new Set(list.flatMap(entry => entry.plugin?.repo ?? []))]

  for (const repo of wanted) {
    const cached = cache[repo]

    // Entries saved before forks, creation date and history were kept are fetched again.
    if (cached?.history !== undefined && now - cached.fetchedAt < REPO_TTL_MS) {
      continue
    }

    const response = await $.http
      .fetch(`https://api.github.com/repos/${repo}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'catalog-pane' },
      })
      .catch(() => undefined)

    if (response?.ok !== true) {
      continue
    }

    const body = JSON.parse(response.text) as {
      stargazers_count?: number
      forks_count?: number
      open_issues_count?: number
      pushed_at?: string
      created_at?: string
      license?: { spdx_id?: string } | null
    }
    const stars = body.stargazers_count ?? 0
    const day = dayOf(now)
    const history = (cached?.history ?? []).filter(point => point.day !== day)
    cache[repo] = {
      stars,
      forks: body.forks_count ?? 0,
      issues: body.open_issues_count ?? 0,
      pushedAt: body.pushed_at ?? '',
      createdAt: body.created_at ?? '',
      license: body.license?.spdx_id,
      history: [...history, { day, stars }].slice(-KEPT_STAR_POINTS),
      fetchedAt: now,
    }
  }

  await $.store.set(REPOS_KEY, cache)
  await update($, repos, () => cache)
}

const scanLine = (text: string, label: string) =>
  text
    .split(/\r?\n/)
    .map(line => new RegExp(`^\\s*\\S+\\s+\\S+\\s+${label}:\\s*(.*)$`).exec(line)?.[1])
    .filter(found => found !== undefined)
    .join('; ')

async function scanMods($: EngineInterface, list: readonly Entry[]) {
  const cache = ((await $.store.get(SCANS_KEY)) ?? {}) as Record<string, Scan>
  const found: Record<string, Scan> = {}

  for (const entry of list) {
    if (entry.kind !== 'mod' || entry.root === undefined) {
      continue
    }

    const cacheKey = `${entry.root}|${entry.plugin?.version ?? entry.detail ?? ''}`
    let scan = cache[cacheKey]

    if (scan === undefined) {
      const run = await $.process
        .run(['claude', 'plugin', 'validate', entry.root], { timeoutMs: CLI_TIMEOUT_MS })
        .catch(() => undefined)

      if (run === undefined) {
        continue
      }

      scan = { hooks: scanLine(run.stdout, 'hooks'), calls: scanLine(run.stdout, 'calls') }
      cache[cacheKey] = scan
      await $.store.set(SCANS_KEY, cache)
    }

    found[entry.id] = scan
    await update($, scans, () => ({ ...found }))
  }
}

async function enrich($: EngineInterface, list: readonly Entry[]) {
  await measureCosts($, list)
  await scanMods($, list)

  if (showsGithub) {
    await fetchRepos($, list)
  }
}

const skillName = (skill: string, pluginName: string | undefined) =>
  pluginName === undefined || skill.includes(':') ? skill : `${pluginName}:${skill}`

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
      const now = await $.clock.now()
      // Re-read the store so counts from other sessions running at the same time survive.
      const merged = merge(((await $.store.get(USAGE_KEY)) ?? {}) as Usage, delta)
      const days = addDay(((await $.store.get(DAILY_KEY)) ?? {}) as Daily, dayOf(now), delta, now)
      await $.store.set(USAGE_KEY, merged)
      await $.store.set(DAILY_KEY, days)
      await update($, pending, marks => subtract(marks, delta))
      await update($, usage, () => merged)
      await update($, daily, () => days)
    }
  } finally {
    isFlushing = false
  }
}

async function snapshot($: EngineInterface) {
  const list = await read($, entries)
  const waiting = await read($, pending)
  const now = await $.clock.now()

  return {
    list,
    stats: statsOf(list, merge(await read($, usage), waiting), waiting, await read($, daily), await read($, costs), now),
    repos: await read($, repos),
    scans: await read($, scans),
    now,
    notes: await read($, explanations),
    busy: await read($, explaining),
    confirming: await read($, confirming),
    working: await read($, working),
    isLoading: await read($, isLoading),
  }
}

async function refresh($: EngineInterface) {
  await update($, isLoading, () => true)

  try {
    const list = await collect($)
    await update($, entries, () => list)
    // One enrichment at a time, so a second refresh reads the caches the first one wrote.
    enriching = enriching.then(() => enrich($, list)).catch(() => undefined)
  } finally {
    await update($, isLoading, () => false)
  }
}

async function startCatalog($: EngineInterface, options: { github: boolean }) {
  showsGithub = options.github
  const stored = ((await $.store.get(USAGE_KEY)) ?? {}) as Usage
  const days = ((await $.store.get(DAILY_KEY)) ?? {}) as Daily
  const known = ((await $.store.get(EXPLANATIONS_KEY)) ?? {}) as Record<string, string>
  const fetched = ((await $.store.get(REPOS_KEY)) ?? {}) as Record<string, RepoStats>
  skills = new Set(((await $.store.get(SKILLS_KEY)) ?? []) as string[])
  agents = ((await $.store.get(AGENTS_KEY)) ?? {}) as Record<string, KnownAgent>
  await update($, usage, () => stored)
  await update($, daily, () => days)
  await update($, explanations, () => known)
  await update($, repos, () => (showsGithub ? fetched : {}))
  $.clock.every(FLUSH_MS, () => void flush($))
}

function trackCatalog(on: On) {
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

async function explainInto(
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

async function cli($: EngineInterface, task: string, argv: readonly string[], done: string) {
  await update($, working, () => task)

  try {
    const result = await $.process.run(['claude', ...argv], { timeoutMs: CLI_TIMEOUT_MS })
    $.ui.toast(
      result.exitCode === 0
        ? `${done} It takes effect in the next session.`
        : `claude ${argv.join(' ')} failed: ${firstLine(result.stderr || result.stdout)}`,
    )
  } catch {
    $.ui.toast(`claude ${argv.join(' ')} could not start.`)
  } finally {
    await update($, working, () => null)
    await update($, confirming, () => null)
  }

  await refresh($)
}

async function ask($: EngineInterface, task: string) {
  await update($, confirming, () => task)
}

async function cancel($: EngineInterface) {
  await update($, confirming, () => null)
}

function confirmation(
  $: EngineInterface,
  { Box, Button, Text }: DetailTags,
  question: string,
  yes: string,
  onYes: () => void,
) {
  return (
    <Box flexDirection="column">
      <Text color="warning">{question}</Text>
      <Box flexDirection="row" gap={1}>
        <Button key="confirm" label={yes} variant="primary" onPress={onYes} />
        <Button key="cancel" label="Cancel" onPress={() => cancel($)} />
      </Box>
    </Box>
  )
}

function pluginActions($: EngineInterface, tags: DetailTags, entry: Entry, props: DetailProps) {
  const { Box, Button } = tags
  const info = entry.plugin

  if (info === undefined) {
    return undefined
  }

  const task = `uninstall:${entry.id}`

  if (props.working !== null && props.working.endsWith(entry.id)) {
    return <Button key="working" label="Working…" onPress={() => undefined} />
  }

  if (props.confirming === task) {
    return confirmation(
      $,
      tags,
      `Uninstall ${info.key}? Its skills, commands and agents go away from the next session on.`,
      'Yes, uninstall',
      () => void cli($, task, ['plugin', 'uninstall', info.key], `Uninstalled ${info.key}.`),
    )
  }

  const hasUpdate = info.latest !== undefined && info.latest !== info.version

  return (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      {hasUpdate && (
        <Button
          key="update"
          label={`Update to v${info.latest}`}
          variant="primary"
          onPress={() =>
            void cli($, `update:${entry.id}`, ['plugin', 'update', info.key], `Updated ${info.key}.`)
          }
        />
      )}
      <Button
        key="toggle"
        label={info.isEnabled ? 'Disable' : 'Enable'}
        onPress={() =>
          void cli(
            $,
            `toggle:${entry.id}`,
            ['plugin', info.isEnabled ? 'disable' : 'enable', info.key],
            `${info.isEnabled ? 'Disabled' : 'Enabled'} ${info.key}.`,
          )
        }
      />
      <Button key="uninstall" label="Uninstall…" onPress={() => void ask($, task)} />
    </Box>
  )
}

function serverActions($: EngineInterface, tags: DetailTags, entry: Entry, props: DetailProps) {
  const { Box, Button } = tags
  const task = `remove:${entry.id}`

  if (props.working === task) {
    return <Button key="working" label="Working…" onPress={() => undefined} />
  }

  if (props.confirming === task) {
    return confirmation(
      $,
      tags,
      `Remove the MCP server ${entry.name} from your configuration?`,
      'Yes, remove',
      () => void cli($, task, ['mcp', 'remove', entry.name], `Removed ${entry.name}.`),
    )
  }

  return (
    <Box flexDirection="row">
      <Button key="remove" label="Remove…" onPress={() => void ask($, task)} />
    </Box>
  )
}

function actions($: EngineInterface, tags: DetailTags, entry: Entry, props: DetailProps) {
  const { Box, Button } = tags

  if (entry.kind === 'skill' || entry.kind === 'command') {
    return (
      <Box flexDirection="row" gap={1}>
        <Button key="insert" label={`Insert /${entry.name}`} variant="primary" onPress={() => insert($, `/${entry.name} `)} />
        <Button key="run" label="Run now" onPress={() => run($, entry.name)} />
      </Box>
    )
  }

  if (isContainer(entry.kind)) {
    return pluginActions($, tags, entry, props)
  }

  const prompts: Partial<Record<Kind, string>> = {
    agent: `Use the ${entry.name} agent to `,
    mcp: `Use the ${entry.name} MCP server to `,
    tool: `Use the ${entry.name} tool to `,
  }
  const prompt = prompts[entry.kind]

  return (
    <Box flexDirection="column" gap={1}>
      {prompt !== undefined && (
        <Box flexDirection="row">
          <Button key="insert" label="Insert into prompt" variant="primary" onPress={() => insert($, prompt)} />
        </Box>
      )}
      {entry.kind === 'mcp' && entry.isRemovable === true && serverActions($, tags, entry, props)}
    </Box>
  )
}

const usageLine = (stat: Stat) =>
  stat.count === 0
    ? 'Never used since the catalog started counting'
    : `Used ${stat.count}× · ${stat.week} in 7 days · ${stat.month} in 30 days · last ${dateOf(stat.lastAt)}`

const costLine = (cost: Cost | undefined) =>
  cost === undefined
    ? undefined
    : `~${shortNumber(cost.alwaysOn)} tokens in every session` +
      (cost.onInvoke === undefined ? '' : ` · ~${shortNumber(cost.onInvoke)} per use`)

const pluginLine = (info: PluginInfo | undefined) =>
  info === undefined
    ? undefined
    : [
        info.version === undefined ? undefined : `v${info.version}`,
        info.isEnabled ? 'enabled' : 'disabled',
        info.installedAt === undefined ? undefined : `installed ${dateOf(info.installedAt)}`,
        info.updatedAt === undefined ? undefined : `updated ${dateOf(info.updatedAt)}`,
      ]
        .filter(Boolean)
        .join(' · ')

const trendText = (repo: RepoStats, now: number) => {
  const trend = trendOf(repo, now)
  const amount = shortNumber(Math.round(Math.abs(trend.perMonth)))
  const sign = trend.perMonth < 0 ? '−' : '+'

  return trend.isMeasured ? `${sign}${amount} ★ a month` : `~${amount} ★ a month on average`
}

const repoLine = (repo: RepoStats, now: number) =>
  [
    `★ ${repo.stars.toLocaleString('en-US')}`,
    trendText(repo, now),
    `${(repo.forks ?? 0).toLocaleString('en-US')} forks`,
    `${repo.issues} open issues`,
    repo.pushedAt === '' ? undefined : `last push ${dateOf(repo.pushedAt)}`,
    repo.license === undefined || repo.license === 'NOASSERTION' ? undefined : repo.license,
  ]
    .filter(Boolean)
    .join(' · ')

function detail($: EngineInterface, tags: DetailTags, props: DetailProps) {
  const { Box, Text, Button, Markdown, Link } = tags
  const { entry, list } = props
  const stat = statOf(props.stats, entry.id)
  const info = entry.plugin
  const repo = info?.repo === undefined ? undefined : props.repos[info.repo]
  const items = isContainer(entry.kind) ? list.filter(one => !isContainer(one.kind) && one.origin === entry.name) : []
  const scan = props.scans[entry.id]
  const facts = [
    `${labelOf(entry.kind)} from ${entry.origin}`,
    usageLine(stat),
    costLine(stat.cost),
    pluginLine(info),
    info?.installs === undefined ? undefined : `${info.installs.toLocaleString('en-US')} installs in the official directory`,
    entry.kind === 'mcp' ? undefined : entry.detail,
    scan === undefined || scan.hooks === '' ? undefined : `Hooks: ${scan.hooks}`,
    scan === undefined || scan.calls === '' ? undefined : `Uses: ${scan.calls}`,
  ].filter(line => line !== undefined)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>
          {entry.name}
        </Text>
        {facts.map(line => (
          <Text dimColor>{line}</Text>
        ))}
        {info?.latest !== undefined && info.latest !== info.version && (
          <Text color="warning">Update available: v{info.latest}</Text>
        )}
        {info?.repo !== undefined && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Link href={`https://github.com/${info.repo}`} label={info.repo} />
            {repo !== undefined && <Text dimColor>{repoLine(repo, props.now)}</Text>}
          </Box>
        )}
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
      {actions($, tags, entry, props)}
      {items.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Provides</Text>
          {items.map(one => (
            <Button key={`item-${one.id}`} plain onPress={() => props.onOpen(one.id)}>
              {one.name} <Text dimColor>{rowText(one, statOf(props.stats, one.id))}</Text>
            </Button>
          ))}
        </Box>
      )}
    </Box>
  )
}

const PANE = 'catalog'
const PAGE = 20
const EMPTY = { count: 0, lastAt: 0, week: 0, month: 0 }

const START: View = {
  kind: 'skill',
  selected: null,
  trail: [],
  query: '',
  sort: 'usage',
  origin: EVERYWHERE,
  page: 0,
}

const view = atom({ plugin: 'catalog-pane', key: 'view' } as const, START)

const startFrom = (args: string): Partial<View> => {
  const word = args.trim().toLowerCase()
  const kind = KINDS.find(one => one.kind === word || one.label.toLowerCase() === word)?.kind

  if (word === '') {
    return {}
  }

  return kind === undefined ? { query: args.trim(), page: 0, selected: null } : { kind, selected: null, page: 0 }
}

export const register: Register = (on, options) => {
  const language = typeof options.language === 'string' && options.language !== '' ? options.language : 'English'
  const github = options.githubStats !== false

  trackCatalog(on)

  on('session.start', async ($, e, next) => {
    await startCatalog($, { github })
    await $.command.register({
      name: 'catalog',
      description: 'Browse skills, commands, agents, plugins, MCP servers and tools in a pane',
      argumentHint: '[category or search]',
    })
    void refresh($)

    if (e.surface === 'desktop') {
      void $.ui.open({ id: PANE, title: 'Catalog' })
    }

    return next(e)
  })

  // The desktop app attaches after the session started, so session.start sees no surface there.
  on('session.attach', async ($, e, next) => {
    if (e.surface === 'desktop') {
      void $.ui.open({ id: PANE, title: 'Catalog' })
    }

    return next(e)
  })

  on('command.run', { command: 'catalog' }, async ($, e) => {
    await update($, view, current => ({ ...current, trail: [], ...startFrom(e.args ?? '') }))
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Catalog' })

    return { text: 'Opened the catalog pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const tags = $.ui.resolve(e)
    const { Box, Button, Text } = tags
    const { list, stats, repos, scans, now, notes, busy, confirming, working, isLoading: loading } = await snapshot($)
    const state = await read($, view)
    const selected = state.selected === null ? undefined : list.find(one => one.id === state.selected)

    const go = (patch: Partial<View>) => update($, view, current => ({ ...current, ...patch }))
    const open = (id: string) =>
      update($, view, current => {
        const target = list.find(one => one.id === id)

        return {
          ...current,
          kind: target?.kind ?? current.kind,
          trail: current.selected === null ? current.trail : [...current.trail, current.selected],
          selected: id,
        }
      })
    const back = () =>
      update($, view, current => ({
        ...current,
        selected: current.trail.at(-1) ?? null,
        trail: current.trail.slice(0, -1),
      }))

    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {KINDS.map(({ kind, label }) => (
          <Button
            key={`tab-${kind}`}
            label={`${label} ${list.filter(one => one.kind === kind).length}`}
            variant={kind === state.kind ? 'primary' : 'secondary'}
            onPress={() => go({ kind, selected: null, trail: [], origin: EVERYWHERE, page: 0 })}
          />
        ))}
        <Button key="refresh" label={loading ? 'Loading…' : 'Refresh'} plain onPress={() => refresh($)} />
      </Box>
    )

    if (selected !== undefined) {
      const crumbs = [...state.trail, selected.id]
        .map(id => list.find(one => one.id === id)?.name ?? id)
        .join(' › ')

      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Box flexDirection="row" gap={1}>
            <Button key="back" label="‹ Back" onPress={back} />
            <Text dimColor wrap="truncate-end">
              {labelOf(selected.kind)} › {crumbs}
            </Text>
          </Box>
          {detail($, tags, {
            entry: selected,
            list,
            stats,
            repos,
            scans,
            now,
            confirming,
            working,
            explanation: notes[explanationKey(language, selected.id)],
            isExplaining: busy.includes(selected.id),
            onOpen: id => void open(id),
            onExplain: () => void explainInto($, selected, language),
          })}
        </Box>
      )
    }

    const rows = visible(list, stats, state, repos, now)
    const pages = Math.max(1, Math.ceil(rows.length / PAGE))
    const page = Math.min(state.page, pages - 1)
    const shown = rows.slice(page * PAGE, (page + 1) * PAGE)

    const filters =
      'Select' in tags ? (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <tags.Input
            key="query"
            label="Filter"
            placeholder="name or description"
            value={state.query}
            onInput={query => void go({ query, page: 0 })}
            onSubmit={query => void go({ query, page: 0 })}
          />
          <tags.Select
            key="sort"
            label="Sort"
            value={state.sort}
            options={SORTS.map(({ sort, label }) => ({ value: sort, label }))}
            onSelect={sort => void go({ sort: sort as Sort, page: 0 })}
          />
          <tags.Select
            key="origin"
            label="From"
            value={state.origin}
            options={[
              { value: EVERYWHERE, label: 'Everywhere' },
              ...originsOf(list, state.kind).map(origin => ({ value: origin })),
            ]}
            onSelect={origin => void go({ origin, page: 0 })}
          />
        </Box>
      ) : undefined

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {filters}
        {list.length === 0 && <Text dimColor>{loading ? 'Collecting…' : 'Nothing found yet. Press Refresh.'}</Text>}
        {list.length > 0 && rows.length === 0 && <Text dimColor>Nothing matches.</Text>}
        <Box flexDirection="column" gap={1}>
          {shown.map(one => (
            <Box key={`row-${one.id}`} flexDirection="column">
              <Button key={`open-${one.id}`} plain onPress={() => open(one.id)}>
                {one.name}{' '}
                <Text dimColor>
                  {[
                    rowText(one, stats[one.id] ?? EMPTY, repos),
                    metricText(state.sort, one, list, stats[one.id] ?? EMPTY, repos, now),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </Button>
              {one.description !== '' && (
                <Text dimColor wrap="truncate-end">
                  {firstLine(one.description)}
                </Text>
              )}
            </Box>
          ))}
        </Box>
        {pages > 1 && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="previous" label="‹ Previous" onPress={() => go({ page: Math.max(0, page - 1) })} />
            <Text dimColor>
              {page * PAGE + 1}–{Math.min(rows.length, (page + 1) * PAGE)} of {rows.length}
            </Text>
            <Button key="next" label="Next ›" onPress={() => go({ page: Math.min(pages - 1, page + 1) })} />
          </Box>
        )}
      </Box>
    )
  })
}
