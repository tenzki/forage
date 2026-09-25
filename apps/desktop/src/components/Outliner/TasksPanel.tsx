import type { Editor } from '@tiptap/react'
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { collectTasks, type TaskEntry } from '../../editor/tasks'
import { collectBullets, selectBullet, toggleBulletCompleted } from '../../editor/outlineModel'
import { setZoom } from '../../editor/outlinerUi'
import { SecondaryViewHeader } from '../SecondaryViewHeader'
import { FilterChip } from '../ui/FilterChip'

export function TasksPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [, setRevision] = useState(0)
  const [filter, setFilter] = useState<'open' | 'all'>('all')
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

  const openTasks = tasks.filter((task) => !task.completed)
  const completedTasks = tasks.filter((task) => task.completed)
  const visible = filter === 'open' ? openTasks : tasks
  const titles = new Map(collectBullets(editor.state.doc).map((entry) => [entry.id, entry.text.trim()]))

  function renderRow(task: TaskEntry) {
    const label = task.text || 'Untitled task'
    const path = task.ancestorIds
      .map((id) => titles.get(id))
      .filter(Boolean)
      .slice(-2)
      .join(' › ')
    return (
      <li key={task.id} className={task.completed ? 'is-completed' : ''}>
        <button
          className="tasks-toggle"
          role="checkbox"
          aria-checked={task.completed}
          aria-label={task.completed ? `Reopen ${label}` : `Mark ${label} complete`}
          onClick={() => toggleBulletCompleted(editor, task.id)}
        >
          {task.completed && <Check size={10} strokeWidth={3} aria-hidden="true" />}
        </button>
        <button
          className="tasks-open"
          aria-label={`Open ${label} in outline`}
          onClick={() => open(task.id)}
        >
          <span>{label}</span>
          {path && <small className="tasks-path">{path}</small>}
        </button>
      </li>
    )
  }

  return (
    <div className="secondary-view t-panel-slide" data-open="true">
      <SecondaryViewHeader onBack={onClose} />
      <section className="tasks-page" aria-label="All tasks">
        <div className="secondary-page-heading">
          <div>
            <h1 className="secondary-page-title">Tasks</h1>
            <p className="secondary-page-description">Every todo in your outline, wherever it grows.</p>
          </div>
          <div className="tasks-filters" role="group" aria-label="Task filter">
            <FilterChip active={filter === 'open'} onClick={() => setFilter('open')}>
              Open <span className="tabular-nums opacity-70">{openTasks.length}</span>
            </FilterChip>
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
              All <span className="tabular-nums opacity-70">{tasks.length}</span>
            </FilterChip>
          </div>
        </div>
        {visible.length === 0 ? (
          <p className="tasks-empty">{tasks.length ? 'No open tasks.' : 'No tasks in the outline.'}</p>
        ) : (
          <>
            {openTasks.length > 0 && (
              <>
                <h3 className="tasks-section-heading">Open</h3>
                <ul className="tasks-list" aria-label="Open tasks">{openTasks.map(renderRow)}</ul>
              </>
            )}
            {filter === 'all' && completedTasks.length > 0 && (
              <>
                <h3 className="tasks-section-heading">Completed</h3>
                <ul className="tasks-list" aria-label="Completed tasks">{completedTasks.map(renderRow)}</ul>
              </>
            )}
          </>
        )}
      </section>
    </div>
  )
}
