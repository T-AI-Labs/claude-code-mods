export type CacheHit = { read: number; total: number }

export type Warmth = { sentAt: number | null; ttlMs: number }

export type KeepWarm = { isOn: boolean; until: number | null; refreshes: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-meter': {
      cache: CacheHit | null
      warmth: Warmth
      keepWarm: KeepWarm
      now: number
    }
  }
}
