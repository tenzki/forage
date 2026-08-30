import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { restoreBullet } from '../../editor/outlineModel'
import { extractText, type TrashEntry } from '../../types/tree'
import { SecondaryViewHeader } from '../SecondaryViewHeader'

interface TrashPanelProps {
  editor: Editor
  entries: TrashEntry[]
  onClose: () => void
  onChange: (entries: TrashEntry[]) => void
  onRestore?: (entry: TrashEntry) => void
  onPurge?: (entry: TrashEntry) => void
  onError: (message: string) => void
}

function entryTitle(entry: TrashEntry): string {
  return extractText(entry.node).trim().split('\n')[0] || 'Untitled bullet'
}

export function TrashPanel({ editor, entries, onClose, onChange, onRestore, onPurge, onError }: TrashPanelProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  function restore(entry: TrashEntry) {
    if (!restoreBullet(editor, entry)) {
      onError('The branch could not be restored because its ID is already in use.')
      return
    }
    if (onRestore) onRestore(entry)
    else onChange(entries.filter((candidate) => candidate.id !== entry.id))
  }

  function purge(entry: TrashEntry) {
    if (confirmId !== entry.id) {
      setConfirmId(entry.id)
      return
    }
    if (onPurge) onPurge(entry)
    else onChange(entries.filter((candidate) => candidate.id !== entry.id))
  }

  return (
    <div className="secondary-view">
      <SecondaryViewHeader title="Trash" onBack={onClose} />
      <section className="trash-page" aria-label="Trash contents">
        <p className="trash-description">Deleted branches remain here until permanently removed.</p>
        {entries.length === 0 ? (
          <p className="trash-empty">Trash is empty.</p>
        ) : (
          <ul className="trash-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <span>
                  <strong>{entryTitle(entry)}</strong>
                  <small>Deleted {new Date(entry.deletedAt).toLocaleString()}</small>
                </span>
                <div>
                  <button onClick={() => restore(entry)}>Restore</button>
                  <button className="danger-action" onClick={() => purge(entry)}>
                    {confirmId === entry.id ? 'Confirm delete' : 'Delete forever'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
