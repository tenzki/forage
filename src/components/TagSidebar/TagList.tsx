import type { TagCount } from '../../store/ipc'

interface TagListProps {
  tags: TagCount[]
  onTagClick: (tag: string) => void
}

/**
 * Renders a list of tags with their node counts.
 * Each tag row shows #tagname and a count badge on the right.
 */
export default function TagList({ tags, onTagClick }: TagListProps) {
  if (tags.length === 0) {
    return <div style={{ fontSize: 12, color: '#9ca3af', padding: '4px 8px' }}>No tags yet</div>
  }

  return (
    <div>
      {tags.map(({ tag, count }) => (
        <div
          key={tag}
          className="tag-list-item"
          onClick={() => onTagClick(tag)}
          title={`Show all nodes tagged #${tag}`}
        >
          <span>#{tag}</span>
          <span className="tag-list-count">{count}</span>
        </div>
      ))}
    </div>
  )
}
