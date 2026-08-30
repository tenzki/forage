import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { collectBullets } from './outlineModel'

export interface TaskEntry {
  id: string
  text: string
  completed: boolean
  ancestorIds: string[]
  pos: number
}

export function collectTasks(doc: ProseMirrorNode): TaskEntry[] {
  const tasks = collectBullets(doc)
    .filter((entry) => entry.bulletKind === 'todo')
    .map((entry) => ({
      id: entry.id,
      text: entry.text,
      completed: entry.completed,
      ancestorIds: [...entry.ancestorIds],
      pos: entry.pos,
    }))
  return [
    ...tasks.filter((task) => !task.completed),
    ...tasks.filter((task) => task.completed),
  ]
}
