import { describe, expect, it } from 'vitest'
import { createOutlineSchema } from '@forage/document'
import { collectTasks } from './tasks'

function item(id: string, text: string, options: { todo?: boolean; completed?: boolean; children?: object[] } = {}) {
  return {
    type: 'listItem',
    attrs: {
      nodeId: id,
      nodeType: 'user',
      collapsed: false,
      bulletKind: options.todo ? 'todo' : 'bullet',
      completed: options.completed ?? false,
      systemRole: null,
      dailyDate: null,
    },
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
      ...(options.children?.length ? [{ type: 'bulletList', content: options.children }] : []),
    ],
  }
}

describe('derived tasks', () => {
  it('collects nested todos and groups open before complete while preserving document order', () => {
    const doc = createOutlineSchema().nodeFromJSON({
      type: 'doc',
      content: [{ type: 'bulletList', content: [
        item('complete-first', 'Completed first in outline', { todo: true, completed: true }),
        item('ordinary', 'Not a task', { children: [
          item('open-nested', 'Nested open', { todo: true }),
          item('complete-nested', 'Nested complete', { todo: true, completed: true }),
        ] }),
        item('open-last', 'Later open', { todo: true }),
        item('tasks-title', 'Tasks'),
      ] }],
    })

    expect(collectTasks(doc)).toEqual([
      expect.objectContaining({ id: 'open-nested', text: 'Nested open', completed: false, ancestorIds: ['ordinary'] }),
      expect.objectContaining({ id: 'open-last', text: 'Later open', completed: false, ancestorIds: [] }),
      expect.objectContaining({ id: 'complete-first', completed: true }),
      expect.objectContaining({ id: 'complete-nested', completed: true }),
    ])
    expect(collectTasks(doc).some((task) => task.id === 'tasks-title')).toBe(false)
  })

  it('returns a fresh live projection rather than retaining copied state', () => {
    const schema = createOutlineSchema()
    const before = schema.nodeFromJSON({
      type: 'doc', content: [{ type: 'bulletList', content: [item('task', 'Task', { todo: true })] }],
    })
    const first = collectTasks(before)
    const taskPos = first[0].pos
    const after = before.type.create(before.attrs, before.content)

    expect(first[0].id).toBe('task')
    expect(taskPos).toBeGreaterThan(0)
    expect(collectTasks(after)).not.toBe(first)
  })
})
