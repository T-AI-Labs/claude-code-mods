export type ContextFill = { percent: number; tokens: number; window: number }

export type UsageWindow = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type Reading = { windows: UsageWindow[] }

declare module 'claude-code' {
  interface PluginState {
    'context-usage': {
      context: ContextFill | null
      threshold: number
      windows: UsageWindow[]
      now: number
    }
  }
}
