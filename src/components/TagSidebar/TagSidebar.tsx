import { useEffect, useState } from 'react'
import { getAllTagsIpc } from '../../store/ipc'
import type { TagCount } from '../../store/ipc'
import TagList from './TagList'

interface TagSidebarProps {
  open: boolean
  onTagClick: (tag: string) => void
}

/**
 * Toggleable left sidebar showing all tags with node counts.
 * Loads tags from the database on mount and whenever it becomes open.
 */
export default function TagSidebar({ open, onTagClick }: TagSidebarProps) {
  const [tags, setTags] = useState<TagCount[]>([])

  useEffect(() => {
    if (!open) return

    getAllTagsIpc()
      .then(setTags)
      .catch((e) => console.error('Failed to load tags:', e))
  }, [open])

  if (!open) return null

  return (
    <div className="tag-sidebar">
      <div className="tag-sidebar-header">Tags</div>
      <TagList tags={tags} onTagClick={onTagClick} />
    </div>
  )
}
