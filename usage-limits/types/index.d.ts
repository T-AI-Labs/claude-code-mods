export type UsageWindow = {
  kind: string
  percentUsed: number
  resetsAt?: string
  isStale?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-limits': { windows: UsageWindow[]; now: number }
  }
}
