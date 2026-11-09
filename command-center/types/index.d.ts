export type Choice = {
  name: string
  description: string
  source: string
  kind?: 'skill' | 'command'
  isManualOnly?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'command-center': {
      agents: Choice[]
      slashes: Choice[]
      agent: string
      slash: string
      source: string
    }
  }
}
