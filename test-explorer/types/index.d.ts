export type Tool =
  | 'dotnet'
  | 'pytest'
  | 'vitest'
  | 'jest'
  | 'mocha'
  | 'playwright'
  | 'go'
  | 'cargo'
  | 'maven'
  | 'gradle'
  | 'rspec'
  | 'claude-plugin'

export type Status = 'unknown' | 'passed' | 'failed' | 'skipped'

export type TestCase = {
  name: string
  group: string
  status: Status
  ms?: number
  message?: string
}

export type Project = {
  id: string
  name: string
  dir: string
  file?: string
  tool: Tool
  tests: TestCase[]
  state: 'idle' | 'discovering' | 'running'
  error?: string
  isOpen: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'test-explorer': {
      projects: Shaped<Project[]>
      isScanning: boolean
      filter: string
      isFailedOnly: boolean
    }
  }
}
