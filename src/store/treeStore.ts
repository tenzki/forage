import { create } from 'zustand'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { nodeToTreeNode, extractText } from '../types/tree'
import type { TreeNode } from '../types/tree'
import type { JsonValue } from '../lib/bindings'
import {
  loadChildren,
  getNodeIpc,
  updateNodeIpc,
  createNodeIpc,
  deleteNodeIpc,
  moveNodeIpc,
  recordUndoStepIpc,
  undoStepIpc,
  redoStepIpc,
  syncNodeTagsIpc,
} from './ipc'
import { positionForInsertAfter, positionForMove } from '../utils/treeHelpers'
import { UndoGroupTracker } from '../utils/undoGrouping'

// Module-level undo group tracker (single instance for the store)
const undoTracker = new UndoGroupTracker()

/**
 * Walk a ProseMirror JSON doc and extract all hashtag node tag values.
 * Hashtag nodes have type === 'hashtag' and attrs.tag.
 */
function extractHashtags(content: JsonValue): string[] {
  const tags: string[] = []

  function walk(node: JsonValue) {
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, JsonValue>
    if (obj.type === 'hashtag' && obj.attrs && typeof obj.attrs === 'object') {
      const attrs = obj.attrs as Record<string, JsonValue>
      if (typeof attrs.tag === 'string' && attrs.tag) {
        tags.push(attrs.tag)
      }
    }
    if (Array.isArray(obj.content)) {
      for (const child of obj.content) {
        walk(child)
      }
    }
  }

  walk(content)
  return tags
}

export interface BreadcrumbItem {
  id: string
  name: string
}

interface TreeState {
  nodes: TreeNode[]
  zoomedNodeId: string | null
  breadcrumb: BreadcrumbItem[]
  isLoading: boolean
  error: string | null
  // Range selection state
  selectedNodeIds: Set<string>
  anchorNodeId: string | null
  // Editor focus
  editingNodeId: string | null
  // Tag click handler (registered by App, called by HashtagNode)
  onTagClick: ((tag: string) => void) | null
}

interface TreeActions {
  loadTree: () => Promise<void>
  toggleNode: (id: string) => Promise<void>
  zoomIn: (id: string) => Promise<void>
  zoomOut: (targetId: string | null) => Promise<void>
  // Editing actions
  createNode: (parentId: string | null, afterNodeId: string | null) => Promise<string>
  deleteNode: (id: string) => Promise<string | null>
  updateContent: (id: string, content: JsonValue) => void
  indentNode: (id: string) => Promise<void>
  outdentNode: (id: string) => Promise<void>
  reorderNode: (id: string, direction: 'up' | 'down') => Promise<void>
  moveNode: (id: string, newParentId: string | null, newPosition: string) => Promise<void>
  // Range selection actions
  selectRange: (anchorId: string, direction: 'up' | 'down') => void
  clearSelection: () => void
  batchIndent: () => Promise<void>
  batchOutdent: () => Promise<void>
  batchDelete: () => Promise<void>
  // Editor focus
  setEditingNode: (id: string | null) => void
  focusPrevNode: (currentId: string) => void
  focusNextNode: (currentId: string) => void
  // Local mutation (no IPC round-trip)
  updateNodeLocally: (id: string, update: Partial<TreeNode>) => void
  // Undo/Redo
  undo: () => Promise<void>
  redo: () => Promise<void>
  // Tag click handler registration
  registerTagClickHandler: (handler: (tag: string) => void) => void
}

export type TreeStore = TreeState & TreeActions

// Debounce map for updateContent
const updateDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Recursively load children for non-collapsed nodes up to `depth` levels deep.
 * react-arborist expects children: [] (empty array) for expandable nodes, never undefined.
 */
async function hydrateNode(node: TreeNode, depth: number): Promise<TreeNode> {
  if (node.collapsed || depth <= 0) {
    return { ...node, children: [] }
  }
  try {
    const childNodes = await loadChildren(node.id)
    const children = await Promise.all(
      childNodes.map((n) => hydrateNode(nodeToTreeNode(n), depth - 1))
    )
    return { ...node, children }
  } catch {
    return { ...node, children: [] }
  }
}

/**
 * Build the breadcrumb trail by walking up parent chain via IPC.
 */
async function buildBreadcrumbFromId(targetId: string): Promise<BreadcrumbItem[]> {
  const trail: BreadcrumbItem[] = []
  let current: string | null = targetId

  while (current !== null) {
    try {
      const node = await getNodeIpc(current)
      trail.unshift({ id: node.id, name: extractText(node.content) || 'Untitled' })
      current = node.parent_id
    } catch {
      break
    }
  }

  return trail
}

/**
 * Find a node by id in the nested tree.
 */
function findNodeById(list: TreeNode[], targetId: string): TreeNode | null {
  for (const n of list) {
    if (n.id === targetId) return n
    const found = findNodeById(n.children, targetId)
    if (found) return found
  }
  return null
}

/**
 * Find the parent of a node in the nested tree.
 */
function findParentOf(
  list: TreeNode[],
  targetId: string,
  parent: TreeNode | null = null
): TreeNode | null {
  for (const n of list) {
    if (n.id === targetId) return parent
    const found = findParentOf(n.children, targetId, n)
    if (found !== undefined) return found
  }
  return undefined as unknown as null
}

/**
 * Update a node's properties in the nested tree (immutably).
 */
function updateNodeInTree(list: TreeNode[], id: string, update: Partial<TreeNode>): TreeNode[] {
  return list.map((n) => {
    if (n.id === id) return { ...n, ...update }
    return { ...n, children: updateNodeInTree(n.children, id, update) }
  })
}

/**
 * Remove a node from the nested tree (immutably).
 */
function removeNodeFromTree(list: TreeNode[], id: string): TreeNode[] {
  return list
    .filter((n) => n.id !== id)
    .map((n) => ({ ...n, children: removeNodeFromTree(n.children, id) }))
}

/**
 * Insert a node into the tree after a given sibling (immutably).
 * If afterNodeId is null, insert at beginning of parent's children.
 */
function insertNodeInTree(
  list: TreeNode[],
  newNode: TreeNode,
  parentId: string | null,
  afterNodeId: string | null
): TreeNode[] {
  if (parentId === null) {
    // Insert at root level
    if (afterNodeId === null) {
      return [newNode, ...list]
    }
    const afterIdx = list.findIndex((n) => n.id === afterNodeId)
    if (afterIdx === -1) return [...list, newNode]
    const result = [...list]
    result.splice(afterIdx + 1, 0, newNode)
    return result
  }

  return list.map((n) => {
    if (n.id === parentId) {
      const children = n.children
      if (afterNodeId === null) {
        return { ...n, children: [newNode, ...children] }
      }
      const afterIdx = children.findIndex((c) => c.id === afterNodeId)
      if (afterIdx === -1) return { ...n, children: [...children, newNode] }
      const newChildren = [...children]
      newChildren.splice(afterIdx + 1, 0, newNode)
      return { ...n, children: newChildren }
    }
    return { ...n, children: insertNodeInTree(n.children, newNode, parentId, afterNodeId) }
  })
}

/**
 * DFS walk of the visible tree (respecting collapsed state) to get flat ordered list of IDs.
 */
function getFlatVisibleIds(nodes: TreeNode[]): string[] {
  const result: string[] = []
  function walk(list: TreeNode[]) {
    for (const n of list) {
      result.push(n.id)
      if (!n.collapsed && n.children.length > 0) {
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return result
}

export const useTreeStore = create<TreeStore>((set, get) => ({
  nodes: [],
  zoomedNodeId: null,
  breadcrumb: [],
  isLoading: false,
  error: null,
  selectedNodeIds: new Set<string>(),
  anchorNodeId: null,
  editingNodeId: null,
  onTagClick: null,

  loadTree: async () => {
    const { zoomedNodeId } = get()
    set({ isLoading: true, error: null })
    try {
      const rootNodes = await loadChildren(zoomedNodeId)
      const nodes = await Promise.all(
        rootNodes.map((n) => hydrateNode(nodeToTreeNode(n), 2))
      )
      set({ nodes, isLoading: false })
    } catch (e) {
      set({ isLoading: false, error: String(e) })
    }
  },

  toggleNode: async (id: string) => {
    const { nodes } = get()

    const target = findNodeById(nodes, id)
    if (!target) return

    const newCollapsed = !target.collapsed

    try {
      await updateNodeIpc(id, null, null, newCollapsed, null)
    } catch (e) {
      console.error('Failed to persist collapsed state:', e)
      return
    }

    if (!newCollapsed) {
      try {
        const childNodes = await loadChildren(id)
        const hydratedChildren = await Promise.all(
          childNodes.map((n) => hydrateNode(nodeToTreeNode(n), 1))
        )
        function insertChildren(list: TreeNode[]): TreeNode[] {
          return list.map((n) => {
            if (n.id === id) return { ...n, collapsed: false, children: hydratedChildren }
            return { ...n, children: insertChildren(n.children) }
          })
        }
        set({ nodes: insertChildren(get().nodes) })
      } catch (e) {
        console.error('Failed to load children on expand:', e)
        set({ nodes: updateNodeInTree(get().nodes, id, { collapsed: newCollapsed, children: [] }) })
      }
    } else {
      set({ nodes: updateNodeInTree(nodes, id, { collapsed: newCollapsed, children: [] }) })
    }
  },

  zoomIn: async (id: string) => {
    set({ isLoading: true, zoomedNodeId: id })

    try {
      const trail = await buildBreadcrumbFromId(id)

      const nodeName = trail[trail.length - 1]?.name ?? 'Untitled'
      try {
        await getCurrentWindow().setTitle(nodeName)
      } catch (e) {
        console.warn('setTitle failed (not in Tauri context?):', e)
      }

      set({ breadcrumb: trail, zoomedNodeId: id })
      await get().loadTree()
    } catch (e) {
      set({ isLoading: false, error: String(e) })
    }
  },

  zoomOut: async (targetId: string | null) => {
    set({ isLoading: true, zoomedNodeId: targetId })

    try {
      if (targetId === null) {
        set({ breadcrumb: [], zoomedNodeId: null })
        try {
          await getCurrentWindow().setTitle('ai-chat')
        } catch (e) {
          console.warn('setTitle failed (not in Tauri context?):', e)
        }
      } else {
        const trail = await buildBreadcrumbFromId(targetId)
        const nodeName = trail[trail.length - 1]?.name ?? 'Untitled'
        try {
          await getCurrentWindow().setTitle(nodeName)
        } catch (e) {
          console.warn('setTitle failed (not in Tauri context?):', e)
        }
        set({ breadcrumb: trail, zoomedNodeId: targetId })
      }

      await get().loadTree()
    } catch (e) {
      set({ isLoading: false, error: String(e) })
    }
  },

  createNode: async (parentId: string | null, afterNodeId: string | null): Promise<string> => {
    const { nodes, zoomedNodeId } = get()

    // Find siblings at the parent level
    // When zoomed, the top-level `nodes` array contains children of the zoomed node.
    // If parentId matches zoomedNodeId (or is null when not zoomed), use nodes directly.
    let siblings: TreeNode[]
    if (parentId === null || parentId === zoomedNodeId) {
      siblings = nodes
    } else {
      const parent = findNodeById(nodes, parentId)
      siblings = parent?.children ?? []
    }

    // Find the index of afterNodeId in siblings
    const afterIndex = afterNodeId
      ? siblings.findIndex((n) => n.id === afterNodeId)
      : siblings.length - 1

    // Resolve the actual afterNodeId for local tree insertion
    // When afterNodeId is null, insert after the last sibling (not at the start)
    const effectiveAfterNodeId = afterNodeId ?? (siblings.length > 0 ? siblings[siblings.length - 1].id : null)

    const position = positionForInsertAfter(siblings, afterIndex)

    const emptyContent: JsonValue = { type: 'doc', content: [{ type: 'paragraph' }] }

    try {
      const newNode = await createNodeIpc(parentId, position, 'note', emptyContent, null, '')
      const treeNode = nodeToTreeNode(newNode)

      // When zoomed and parentId is the zoomed node, insert at top level of visible tree
      const insertParentId = (parentId === zoomedNodeId) ? null : parentId

      set({
        nodes: insertNodeInTree(get().nodes, treeNode, insertParentId, effectiveAfterNodeId),
        editingNodeId: newNode.id,
      })

      // Record undo step: before_json='{}' (node didn't exist), after_json=new node snapshot
      recordUndoStepIpc('create', newNode.id, '{}', JSON.stringify(newNode)).catch((e) =>
        console.warn('Failed to record undo step for createNode:', e)
      )

      return newNode.id
    } catch (e) {
      console.error('Failed to create node:', e)
      throw e
    }
  },

  deleteNode: async (id: string): Promise<string | null> => {
    const { nodes } = get()

    // Find what should receive focus after deletion (previous sibling or parent)
    const parent = findParentOf(nodes, id)
    const siblings = parent ? parent.children : nodes
    const idx = siblings.findIndex((n) => n.id === id)

    let focusId: string | null = null
    if (idx > 0) {
      focusId = siblings[idx - 1].id
    } else if (parent) {
      focusId = parent.id
    }

    try {
      // Capture before snapshot BEFORE deletion for undo recording
      let beforeSnapshot: string = '{}'
      try {
        const beforeNode = await getNodeIpc(id)
        beforeSnapshot = JSON.stringify(beforeNode)
      } catch {
        // If node doesn't exist, proceed with empty snapshot
      }

      await deleteNodeIpc(id)
      set({
        nodes: removeNodeFromTree(get().nodes, id),
        editingNodeId: focusId,
      })

      // Record undo step: before_json=deleted node snapshot, after_json='{}'
      recordUndoStepIpc('delete', id, beforeSnapshot, '{}').catch((e) =>
        console.warn('Failed to record undo step for deleteNode:', e)
      )

      return focusId
    } catch (e) {
      console.error('Failed to delete node:', e)
      throw e
    }
  },

  updateContent: (id: string, content: JsonValue) => {
    const text = extractText(content)
    const now = Date.now()

    // Undo grouping: check if we need to start a new group
    if (undoTracker.shouldStartNewGroup(id, now)) {
      // Flush the previous group by recording it as an undo step
      const prevGroup = undoTracker.flush()
      if (prevGroup) {
        const prevNodeId = prevGroup.startSnapshot as { id?: string }
        const nodeIdForGroup = (prevNodeId?.id as string) ?? id
        recordUndoStepIpc(
          'text_edit',
          nodeIdForGroup,
          JSON.stringify(prevGroup.startSnapshot),
          // after_json will be the current state — captured at flush time
          JSON.stringify(content),
          prevGroup.groupKey
        ).catch((e) => console.warn('Failed to record undo step for text group:', e))
      }

      // Start a new group with the current node snapshot (from local tree state)
      const currentNode = findNodeById(get().nodes, id)
      const snapshot = currentNode ? { id: currentNode.id, content: currentNode.content } : { id, content }
      undoTracker.startGroup(id, snapshot)
    } else {
      // Update last-edit timestamp to extend the current group window
      undoTracker.touch(id, now)
    }

    // Optimistic local update
    set({ nodes: updateNodeInTree(get().nodes, id, { name: text, content }) })

    // Debounce IPC call (300ms)
    const existing = updateDebounceTimers.get(id)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(async () => {
      updateDebounceTimers.delete(id)
      try {
        await updateNodeIpc(id, content, null, null, null, text)

        // Extract hashtag nodes from content JSON and sync to node_tags table
        const tags = extractHashtags(content)
        syncNodeTagsIpc(id, tags).catch((e) =>
          console.warn('Failed to sync node tags:', e)
        )
      } catch (e) {
        console.error('Failed to persist content update:', e)
      }
    }, 300)

    updateDebounceTimers.set(id, timer)
  },

  indentNode: async (id: string) => {
    const { nodes } = get()

    const parent = findParentOf(nodes, id)
    const siblings = parent ? parent.children : nodes
    const idx = siblings.findIndex((n) => n.id === id)

    if (idx <= 0) return // No previous sibling — no-op

    const prevSibling = siblings[idx - 1]

    // Position at end of prevSibling's children
    const prevSiblingChildren = prevSibling.children
    const newPosition = positionForInsertAfter(prevSiblingChildren, prevSiblingChildren.length - 1)
    const lastChildId = prevSiblingChildren.length > 0 ? prevSiblingChildren[prevSiblingChildren.length - 1].id : null

    try {
      // Capture before snapshot
      let beforeSnapshot: string = '{}'
      try {
        const beforeNode = await getNodeIpc(id)
        beforeSnapshot = JSON.stringify(beforeNode)
      } catch { /* ignore */ }

      await moveNodeIpc(id, prevSibling.id, newPosition)

      // Update local tree: remove from current location, add at end of prevSibling children
      const nodeToMove = findNodeById(nodes, id)
      if (!nodeToMove) return

      const updatedNode = { ...nodeToMove, parent_id: prevSibling.id, position: newPosition }
      const withRemoved = removeNodeFromTree(get().nodes, id)
      set({ nodes: insertNodeInTree(withRemoved, updatedNode, prevSibling.id, lastChildId) })

      // Record undo step
      const afterNode = await getNodeIpc(id).catch(() => null)
      if (afterNode) {
        recordUndoStepIpc('indent', id, beforeSnapshot, JSON.stringify(afterNode)).catch((e) =>
          console.warn('Failed to record undo step for indentNode:', e)
        )
      }
    } catch (e) {
      console.error('Failed to indent node:', e)
    }
  },

  outdentNode: async (id: string) => {
    const { nodes } = get()

    const parent = findParentOf(nodes, id)
    if (!parent) return // Already at root — no-op

    const grandParent = findParentOf(nodes, parent.id)
    const grandParentId = grandParent ? grandParent.id : null

    const grandSiblings = grandParent ? grandParent.children : nodes
    const parentIdx = grandSiblings.findIndex((n) => n.id === parent.id)

    // Position after parent in grandparent's children
    const newPosition = positionForInsertAfter(grandSiblings, parentIdx)

    try {
      // Capture before snapshot
      let beforeSnapshot: string = '{}'
      try {
        const beforeNode = await getNodeIpc(id)
        beforeSnapshot = JSON.stringify(beforeNode)
      } catch { /* ignore */ }

      await moveNodeIpc(id, grandParentId, newPosition)

      const nodeToMove = findNodeById(nodes, id)
      if (!nodeToMove) return

      const updatedNode = { ...nodeToMove, parent_id: grandParentId, position: newPosition }
      const withRemoved = removeNodeFromTree(get().nodes, id)
      set({ nodes: insertNodeInTree(withRemoved, updatedNode, grandParentId, parent.id) })

      // Record undo step
      const afterNode = await getNodeIpc(id).catch(() => null)
      if (afterNode) {
        recordUndoStepIpc('outdent', id, beforeSnapshot, JSON.stringify(afterNode)).catch((e) =>
          console.warn('Failed to record undo step for outdentNode:', e)
        )
      }
    } catch (e) {
      console.error('Failed to outdent node:', e)
    }
  },

  reorderNode: async (id: string, direction: 'up' | 'down') => {
    const { nodes } = get()

    const parent = findParentOf(nodes, id)
    const siblings = parent ? parent.children : nodes
    const idx = siblings.findIndex((n) => n.id === id)

    if (direction === 'up' && idx <= 0) return
    if (direction === 'down' && idx >= siblings.length - 1) return

    const targetIdx = direction === 'up' ? idx - 1 : idx + 2
    const newPosition = positionForMove(siblings, targetIdx, [id])

    try {
      const parentId = parent ? parent.id : null

      // Capture before snapshot
      let beforeSnapshot: string = '{}'
      try {
        const beforeNode = await getNodeIpc(id)
        beforeSnapshot = JSON.stringify(beforeNode)
      } catch { /* ignore */ }

      await moveNodeIpc(id, parentId, newPosition)

      // Update local tree
      const nodeToMove = findNodeById(nodes, id)
      if (!nodeToMove) return

      const updatedNode = { ...nodeToMove, position: newPosition }
      const withRemoved = removeNodeFromTree(get().nodes, id)

      // Re-insert at new position
      const afterId = direction === 'up'
        ? (idx - 2 >= 0 ? siblings[idx - 2].id : null)
        : siblings[idx + 1].id

      set({ nodes: insertNodeInTree(withRemoved, updatedNode, parentId, afterId) })

      // Record undo step
      const afterNode = await getNodeIpc(id).catch(() => null)
      if (afterNode) {
        recordUndoStepIpc('move', id, beforeSnapshot, JSON.stringify(afterNode)).catch((e) =>
          console.warn('Failed to record undo step for reorderNode:', e)
        )
      }
    } catch (e) {
      console.error('Failed to reorder node:', e)
    }
  },

  moveNode: async (id: string, newParentId: string | null, newPosition: string) => {
    const { nodes } = get()

    try {
      await moveNodeIpc(id, newParentId, newPosition)

      const nodeToMove = findNodeById(nodes, id)
      if (!nodeToMove) return

      const updatedNode = { ...nodeToMove, parent_id: newParentId, position: newPosition }
      const withRemoved = removeNodeFromTree(get().nodes, id)
      // Insert at end of new parent (arborist already computed position)
      set({ nodes: insertNodeInTree(withRemoved, updatedNode, newParentId, null) })
    } catch (e) {
      console.error('Failed to move node:', e)
    }
  },

  // --- Range selection ---

  selectRange: (anchorId: string, direction: 'up' | 'down') => {
    const { nodes, selectedNodeIds, anchorNodeId } = get()
    const flatIds = getFlatVisibleIds(nodes)

    // Determine effective anchor
    const effectiveAnchor = anchorNodeId ?? anchorId
    const anchorIdx = flatIds.indexOf(effectiveAnchor)
    if (anchorIdx === -1) return

    // Determine current selection extent
    const currentIds = Array.from(selectedNodeIds)
    const indices = currentIds
      .map((id) => flatIds.indexOf(id))
      .filter((i) => i !== -1)

    let minIdx = indices.length > 0 ? Math.min(...indices) : anchorIdx
    let maxIdx = indices.length > 0 ? Math.max(...indices) : anchorIdx

    if (direction === 'down') {
      maxIdx = Math.min(maxIdx + 1, flatIds.length - 1)
    } else {
      minIdx = Math.max(minIdx - 1, 0)
    }

    const newSelected = new Set(flatIds.slice(minIdx, maxIdx + 1))
    set({ selectedNodeIds: newSelected, anchorNodeId: effectiveAnchor })
  },

  clearSelection: () => {
    set({ selectedNodeIds: new Set<string>(), anchorNodeId: null })
  },

  batchIndent: async () => {
    const { selectedNodeIds } = get()
    if (selectedNodeIds.size === 0) return

    const { nodes } = get()
    const flatIds = getFlatVisibleIds(nodes)
    const orderedIds = flatIds.filter((id) => selectedNodeIds.has(id))

    for (const id of orderedIds) {
      await get().indentNode(id)
    }

    set({ selectedNodeIds: new Set<string>(), anchorNodeId: null })
  },

  batchOutdent: async () => {
    const { selectedNodeIds } = get()
    if (selectedNodeIds.size === 0) return

    const { nodes } = get()
    const flatIds = getFlatVisibleIds(nodes)
    const orderedIds = flatIds.filter((id) => selectedNodeIds.has(id)).reverse()

    for (const id of orderedIds) {
      await get().outdentNode(id)
    }

    set({ selectedNodeIds: new Set<string>(), anchorNodeId: null })
  },

  batchDelete: async () => {
    const { selectedNodeIds } = get()
    if (selectedNodeIds.size === 0) return

    const { nodes } = get()
    const flatIds = getFlatVisibleIds(nodes)
    const orderedIds = flatIds.filter((id) => selectedNodeIds.has(id)).reverse()

    let focusId: string | null = null
    for (const id of orderedIds) {
      const result = await get().deleteNode(id)
      if (focusId === null) focusId = result
    }

    set({
      selectedNodeIds: new Set<string>(),
      anchorNodeId: null,
      editingNodeId: focusId,
    })
  },

  setEditingNode: (id: string | null) => {
    set({ editingNodeId: id })
    if (id !== null) {
      set({ selectedNodeIds: new Set<string>(), anchorNodeId: null })
    }
  },

  focusPrevNode: (currentId: string) => {
    const { nodes } = get()
    const flatIds = getFlatVisibleIds(nodes)
    const idx = flatIds.indexOf(currentId)
    if (idx > 0) {
      set({ editingNodeId: flatIds[idx - 1], selectedNodeIds: new Set<string>(), anchorNodeId: null })
    }
  },

  focusNextNode: (currentId: string) => {
    const { nodes } = get()
    const flatIds = getFlatVisibleIds(nodes)
    const idx = flatIds.indexOf(currentId)
    if (idx >= 0 && idx < flatIds.length - 1) {
      set({ editingNodeId: flatIds[idx + 1], selectedNodeIds: new Set<string>(), anchorNodeId: null })
    }
  },

  updateNodeLocally: (id: string, update: Partial<TreeNode>) => {
    set({ nodes: updateNodeInTree(get().nodes, id, update) })
  },

  registerTagClickHandler: (handler: (tag: string) => void) => {
    set({ onTagClick: handler })
  },

  undo: async () => {
    // Flush any pending text edit group before undoing
    const pending = undoTracker.flush()
    if (pending) {
      // The pending group's after_json is whatever is currently in the tree
      // We can't easily get the current node snapshot here, so just discard the flush
      // (the group wasn't recorded yet — it's still being typed)
      // This means text edits since the last group start won't be captured, which is
      // acceptable since the user is explicitly triggering undo
    }

    try {
      const result = await undoStepIpc()
      if (result && result.node_ids.length > 0) {
        // Reload tree to reflect restored state from DB
        await get().loadTree()
      }
    } catch (e) {
      console.error('Failed to undo:', e)
    }
  },

  redo: async () => {
    try {
      const result = await redoStepIpc()
      if (result && result.node_ids.length > 0) {
        // Reload tree to reflect re-applied state from DB
        await get().loadTree()
      }
    } catch (e) {
      console.error('Failed to redo:', e)
    }
  },
}))
