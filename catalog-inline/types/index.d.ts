export type Kind = 'skill' | 'command' | 'agent' | 'plugin' | 'mcp' | 'tool'

export type Entry = {
  id: string
  kind: Kind
  name: string
  description: string
  origin: string
  detail?: string
}

export type Mark = { count: number; lastAt: number }

export type Usage = Record<string, Mark>

export type KnownAgent = { name: string; description: string; source: string }

export type Sort = 'usage' | 'name'

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
    'catalog-inline': {
      entries: Entry[]
      isLoading: boolean
      usage: Usage
      pending: Usage
      views: StateFamily<View | null>
      band: View
      isBandOpen: boolean
      explanations: Record<string, string>
      explaining: string[]
    }
  }
}
