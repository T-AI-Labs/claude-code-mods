export type Kind = 'skill' | 'command' | 'agent' | 'mod' | 'plugin' | 'hook' | 'mcp' | 'tool'

export type Tab = Kind | 'all' | 'claude'

export type Layout = 'list' | 'gallery' | 'table'

export type Status = 'any' | 'enabled' | 'disabled' | 'update' | 'github' | 'unused'

export type Cost = { alwaysOn: number; onInvoke?: number }

export type PluginInfo = {
  key: string
  version?: string
  latest?: string
  isEnabled: boolean
  installedAt?: string
  updatedAt?: string
  repo?: string
  installs?: number
}

export type Entry = {
  id: string
  kind: Kind
  name: string
  description: string
  origin: string
  detail?: string
  plugin?: PluginInfo
  root?: string
  isRemovable?: boolean
  repo?: string
  changedAt?: number
}

export type Scan = { hooks: string; calls: string }

export type Mark = { count: number; lastAt: number }

export type Usage = Record<string, Mark>

export type Daily = Record<string, Record<string, number>>

export type Stat = Mark & { week: number; month: number; cost?: Cost }

export type StarPoint = { day: string; stars: number }

export type RepoStats = {
  stars: number
  forks: number
  issues: number
  pushedAt: string
  createdAt: string
  license?: string
  history: StarPoint[]
  fetchedAt: number
}

export type KnownAgent = {
  name: string
  description: string
  source: string
  path?: string
  changedAt?: number
  repo?: string
}

export type Release = { version: string; changes: string[] }

export type Releases = { latest?: string; releases: Release[]; fetchedAt: number }

export type Harness = {
  version: string
  base?: string
  builtAt?: string
  model: string
  surfaces: string[]
  entrypoint?: string
  permissionMode?: string
  outputStyle?: string
  configDir: string
  root: string
}

export type Sort =
  | 'usage'
  | 'recent'
  | 'name'
  | 'cleanup'
  | 'cost'
  | 'stars'
  | 'trending'
  | 'forks'
  | 'pushed'
  | 'installs'
  | 'installed'

export type View = {
  kind: Tab
  layout: Layout
  status: Status
  isReversed: boolean
  selected: string | null
  trail: string[]
  query: string
  sort: Sort
  origin: string
  page: number
}

declare module 'claude-code' {
  interface PluginState {
    'catalog-pane': {
      entries: Entry[]
      isLoading: boolean
      usage: Usage
      pending: Usage
      daily: Daily
      costs: Record<string, Cost>
      repos: Record<string, RepoStats>
      scans: Record<string, Scan>
      view: View
      explanations: Record<string, string>
      explaining: string[]
      confirming: string | null
      working: string | null
      harness: Harness | null
      releases: Releases | null
    }
  }
}
