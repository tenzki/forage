import { useEffect, useRef, useState } from 'react'
import { Tree } from 'react-arborist'
import { useTreeStore } from '../../store/treeStore'
import NodeRow from './NodeRow'
import Breadcrumb from './Breadcrumb'

/**
 * Root outliner container.
 * Uses react-arborist Tree in controlled mode (data prop).
 * Expand/collapse is handled via treeStore.toggleNode (not react-arborist internal state).
 */
export default function OutlinerView() {
  const nodes = useTreeStore((s) => s.nodes)
  const isLoading = useTreeStore((s) => s.isLoading)
  const toggleNode = useTreeStore((s) => s.toggleNode)
  const loadTree = useTreeStore((s) => s.loadTree)

  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: window.innerWidth, height: window.innerHeight })

  // Load tree on mount
  useEffect(() => {
    loadTree()
  }, [loadTree])

  // Update dimensions on resize
  useEffect(() => {
    function onResize() {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        setDimensions({ width: rect.width, height: rect.height })
      }
    }

    // Set initial size after mount
    onResize()

    const observer = new ResizeObserver(onResize)
    if (containerRef.current) observer.observe(containerRef.current)

    return () => observer.disconnect()
  }, [])

  function handleToggle(id: string) {
    // Override react-arborist's internal toggle — delegate to store
    toggleNode(id)
  }

  return (
    <div className="outliner-container" ref={containerRef}>
      <Breadcrumb />

      {isLoading && nodes.length === 0 && (
        <div className="outliner-loading">Loading…</div>
      )}

      {!isLoading && nodes.length === 0 && (
        <div className="outliner-empty">
          Press Enter to create your first note
        </div>
      )}

      <div
        className="outliner-tree"
        style={{ opacity: isLoading ? 0.6 : 1, transition: 'opacity 150ms ease' }}
      >
        <Tree<any>
          data={nodes}
          onToggle={handleToggle}
          rowHeight={28}
          indent={24}
          openByDefault={true}
          width={dimensions.width - 40}
          height={dimensions.height - 60}
          disableDrag={true}
          disableDrop={true}
        >
          {NodeRow}
        </Tree>
      </div>
    </div>
  )
}
