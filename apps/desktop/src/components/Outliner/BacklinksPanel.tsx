import { Link2 } from 'lucide-react'
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

  const targetTitle = byId.get(resolvedTargetId)?.text.trim() ?? ''

  return (
    <section className="outline-backlinks" aria-label="Backlinks">
      <h2>
        <Link2 size={14} aria-hidden="true" />
        {owners.length} linked reference{owners.length === 1 ? '' : 's'}
      </h2>
      <ul>
        {owners.map((source) => {
          const ancestors = source.ancestorIds
            .map((id) => byId.get(id)?.text.trim())
            .filter((text): text is string => Boolean(text))
          const excerpt = source.text.trim() || 'Untitled'
          const path = [...ancestors, excerpt].join(' › ')
          return (
            <li key={source.id}>
              <button aria-label={path} onClick={() => { setZoom(editor, source.id); selectBullet(editor, source.id) }}>
                <small className="outline-backlink-source">{ancestors.join(' › ') || 'Home'}</small>
                <span className="outline-backlink-excerpt">
                  <BacklinkExcerpt text={excerpt} target={targetTitle} />
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function BacklinkExcerpt({ text, target }: { text: string; target: string }) {
  const index = target ? text.indexOf(target) : -1
  if (index < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, index)}
      <span className="outline-backlink-target">{target}</span>
      {text.slice(index + target.length)}
    </>
  )
}
