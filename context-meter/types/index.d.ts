export type ContextFill = { percent: number; tokens: number; window: number }

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      context: ContextFill | null
      threshold: number
    }
  }
}
