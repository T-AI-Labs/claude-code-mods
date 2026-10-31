export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Bucket = Tokens & {
  turns: number
  tools: number
  ms: number
  usd: number
}

export type LastTurn = Tokens & { model: string; ms: number; usd: number; at: number }

export type ToolUse = { calls: number; chars: number }

export type PromptRecord = Tokens & {
  at: number
  text: string
  model: string
  ms: number
  usd: number
  steps: number
  peakContext: number
  firstWrite: number
  isAborted: boolean
  agents: Tokens & { runs: number }
  tools: Record<string, ToolUse>
}

// One per session id, written by that session alone so parallel sessions never race on a key.
export type SessionRecord = {
  project: string
  lastAt: number
  usdSeen: number
  model: string
  days: Record<string, Record<string, Bucket>>
  lastTurn?: LastTurn
  title?: string
  prompts?: PromptRecord[]
}

export type LimitWindow = { resetsAt: string; peak: number; lastAt: number }

export type Limits = Record<string, LimitWindow[]>

export type Period = 'turn' | 'session' | 'today' | 'week' | 'month'

export type View = Period | 'sessions' | 'prompts'

export type Slice = {
  total: Bucket
  models: Record<string, Bucket>
  projects: Record<string, Bucket>
}

export type SessionSummary = {
  id: string
  project: string
  title: string
  lastAt: number
  usd: number
  tokens: number
  prompts: PromptRecord[]
}

export type Report = {
  builtAt: number
  periods: Record<Period, Slice>
  limits: Limits
  hasCost: boolean
  ownId: string
  sessions: SessionSummary[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-pane': {
      report: Shaped<Report | null>
      period: View
      isLoading: boolean
      sessionId: string | null
      promptAt: number | null
    }
  }
}
