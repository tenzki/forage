import { useTreeStore } from '../../store/treeStore'

/**
 * Breadcrumb trail for zoom navigation.
 * Only visible when zoomedNodeId !== null.
 * Format: Home > Parent > Current (last segment is non-clickable)
 */
export default function Breadcrumb() {
  const breadcrumb = useTreeStore((s) => s.breadcrumb)
  const zoomedNodeId = useTreeStore((s) => s.zoomedNodeId)
  const zoomOut = useTreeStore((s) => s.zoomOut)

  if (zoomedNodeId === null) return null

  return (
    <nav className="breadcrumb" aria-label="Zoom navigation">
      {/* Home segment always present */}
      <button
        className="breadcrumb-segment breadcrumb-link"
        onClick={() => zoomOut(null)}
        type="button"
      >
        Home
      </button>

      {breadcrumb.map((item, index) => {
        const isLast = index === breadcrumb.length - 1

        return (
          <span key={item.id} className="breadcrumb-item">
            <span className="breadcrumb-separator" aria-hidden="true">›</span>
            {isLast ? (
              <span className="breadcrumb-segment breadcrumb-current">
                {item.name || 'Untitled'}
              </span>
            ) : (
              <button
                className="breadcrumb-segment breadcrumb-link"
                onClick={() => zoomOut(item.id)}
                type="button"
              >
                {item.name || 'Untitled'}
              </button>
            )}
          </span>
        )
      })}
    </nav>
  )
}
