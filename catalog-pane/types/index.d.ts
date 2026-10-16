export type Kind = 'skill' | 'command' | 'agent' | 'mod' | 'plugin' | 'hook' | 'mcp' | 'tool'

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
}

export type Scan = { hooks: string; calls: string }

export type Mark = { count: number; lastAt: number }

export type Usage = Record<string, Mark>

export type Daily = Record<string, Record<string, number>>

export type Stat = Mark & { week: number; month: number; cost?: Cost }

export type RepoStats = {
  stars: number
  issues: number
  pushedAt: string
  license?: string
  fetchedAt: number
}

export type KnownAgent = { name: string; description: string; source: string }

export type Sort = 'usage' | 'name' | 'cleanup'

export type View = {
  kind: Kind
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
    }
  }
}
