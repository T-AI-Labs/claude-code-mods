export type UsageWindow = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type Reading = { windows: UsageWindow[] }

declare module 'claude-code' {
  interface PluginState {
    'usage-limits': {
      windows: UsageWindow[]
      now: number
    }
  }
}
