import type { Editor } from '@tiptap/react'
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { collectTasks } from '../../editor/tasks'
import { selectBullet, toggleBulletCompleted } from '../../editor/outlineModel'
import { setZoom } from '../../editor/outlinerUi'
import { SecondaryViewHeader } from '../SecondaryViewHeader'

export function TasksPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [, setRevision] = useState(0)
  useEffect(() => {
    const update = () => setRevision((value) => value + 1)
    editor.on('transaction', update)
    return () => { editor.off('transaction', update) }
  }, [editor])
  const tasks = collectTasks(editor.state.doc)

  function open(id: string) {
    setZoom(editor, id)
    selectBullet(editor, id)
    onClose()
  }

  return (
    <div className="secondary-view">
      <SecondaryViewHeader title="Tasks" onBack={onClose} />
      <section className="tasks-page" aria-label="All tasks">
        {tasks.length === 0 ? (
          <p className="tasks-empty">No tasks in the outline.</p>
        ) : (
          <ul className="tasks-list">
            {tasks.map((task) => (
              <li key={task.id} className={task.completed ? 'is-completed' : ''}>
                <button
                  className="tasks-toggle"
                  role="checkbox"
                  aria-checked={task.completed}
                  aria-label={task.completed ? `Reopen ${task.text || 'Untitled task'}` : `Mark ${task.text || 'Untitled task'} complete`}
                  onClick={() => toggleBulletCompleted(editor, task.id)}
                >
                  {task.completed && <Check size={12} aria-hidden="true" />}
                </button>
                <button
                  className="tasks-open"
                  aria-label={`Open ${task.text || 'Untitled task'} in outline`}
                  onClick={() => open(task.id)}
                >
                  <span>{task.text || 'Untitled task'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
