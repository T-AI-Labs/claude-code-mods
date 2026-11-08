export type Choice = { name: string; description: string; source: string }

declare module 'claude-code' {
  interface PluginState {
    'command-center': {
      agents: Choice[]
      skills: Choice[]
      commands: Choice[]
      agent: string
      skill: string
      command: string
      source: string
    }
  }
}
