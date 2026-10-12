export type CacheHit = { read: number; total: number }

export type ContextFill = { percent: number; tokens: number; window: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-meter': {
      cache: CacheHit | null
      context: ContextFill | null
      threshold: number
    }
  }
}
