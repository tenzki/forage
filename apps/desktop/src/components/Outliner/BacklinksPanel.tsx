import { CornerUpLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { collectBacklinks, soleInternalLinkTarget } from '../../editor/internalLinks'
import { collectBullets, selectBullet, type BulletEntry } from '../../editor/outlineModel'
import { getOutlinerUiState, setZoom } from '../../editor/outlinerUi'

interface BacklinksPanelProps {
  editor: Editor
  targetId?: string | null
}

function backlinkOwner(
  source: BulletEntry,
  targetId: string,
  byId: Map<string, BulletEntry>,
): BulletEntry {
  if (soleInternalLinkTarget(source) !== targetId) return source
  const parentId = source.ancestorIds[source.ancestorIds.length - 1]
  return (parentId && byId.get(parentId)) || source
}

export function BacklinksPanel({ editor, targetId }: BacklinksPanelProps) {
  const [, setRevision] = useState(0)
  useEffect(() => {
    if (targetId !== undefined) return
    const update = () => setRevision((revision) => revision + 1)
    editor.on('transaction', update)
    return () => {
      editor.off('transaction', update)
    }
  }, [editor, targetId])

  const resolvedTargetId = targetId === undefined ? getOutlinerUiState(editor).zoomId : targetId
  if (!resolvedTargetId) return null
  const backlinks = collectBacklinks(editor.state.doc, resolvedTargetId)
  if (!backlinks.length) return null
  const entries = collectBullets(editor.state.doc)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const owners = [...new Map(backlinks.map(({ source }) => {
    const owner = backlinkOwner(source, resolvedTargetId, byId)
    return [owner.id, owner]
  })).values()]

  return (
    <section className="outline-backlinks" aria-label="Backlinks">
      <h2><CornerUpLeft size={13} aria-hidden="true" /> Linked from</h2>
      <ul>
        {owners.map((source) => {
          const path = [
            ...source.ancestorIds.map((id) => byId.get(id)?.text.trim()),
            source.text.trim() || 'Untitled',
          ].filter(Boolean).join(' › ')
          return (
            <li key={source.id}>
              <button onClick={() => { setZoom(editor, source.id); selectBullet(editor, source.id) }}>
                <span>{path}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
