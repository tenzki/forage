export type OutlineCommandId = 'todo' | 'done' | 'open' | 'bullet' | 'note'

export interface OutlineCommandDefinition {
  id: OutlineCommandId
  label: OutlineCommandId
  description: string
}

export const OUTLINE_COMMANDS: OutlineCommandDefinition[] = [
  { id: 'todo', label: 'todo', description: 'Convert this bullet to an open todo' },
  { id: 'done', label: 'done', description: 'Convert this bullet to a completed todo' },
  { id: 'open', label: 'open', description: 'Mark this todo as open' },
  { id: 'bullet', label: 'bullet', description: 'Convert this todo back to a bullet' },
  { id: 'note', label: 'note', description: 'Add or focus a secondary node note' },
]
