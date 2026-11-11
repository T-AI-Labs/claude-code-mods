export type Status = 'idea' | 'todo' | 'doing' | 'done' | 'snippet'

export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

export type Scope = 'project' | 'global'

export type Tab = 'board' | 'snippets'

export type Task = {
  number: number
  title: string
  details: string
  status: Status
  priority: Priority
  createdAt: number
  updatedAt: number
}

export type Board = { next: number; tasks: Task[] }

declare module 'claude-code' {
  interface PluginState {
    'task-board': {
      board: Shaped<Board>
      scope: Scope
      tab: Tab
      picked: number
      opened: number
      isDeleting: boolean
      rowDraft: string
      newDraft: string
      titleDraft: string
      detailsDraft: string
    }
  }
}
