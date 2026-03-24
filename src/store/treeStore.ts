import { create } from 'zustand'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { nodeToTreeNode, extractText } from '../types/tree'
import type { TreeNode } from '../types/tree'
import { loadChildren, getNodeIpc, updateNodeIpc } from './ipc'

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
}

interface TreeActions {
  loadTree: () => Promise<void>
  toggleNode: (id: string) => Promise<void>
  zoomIn: (id: string) => Promise<void>
  zoomOut: (targetId: string | null) => Promise<void>
}

export type TreeStore = TreeState & TreeActions

/**
 * Recursively load children for non-collapsed nodes up to `depth` levels deep.
 * react-arborist expects children: [] (empty array) for expandable nodes, never undefined.
 */
async function hydrateNode(node: TreeNode, depth: number): Promise<TreeNode> {
  if (node.collapsed || depth <= 0) {
    // Collapsed or max depth reached — keep children as empty array (will lazy-load on toggle)
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
 * Returns array from root to the target node (inclusive), prefixed with Home sentinel.
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

export const useTreeStore = create<TreeStore>((set, get) => ({
  nodes: [],
  zoomedNodeId: null,
  breadcrumb: [],
  isLoading: false,
  error: null,

  loadTree: async () => {
    const { zoomedNodeId } = get()
    set({ isLoading: true, error: null })
    try {
      const rootNodes = await loadChildren(zoomedNodeId)
      // Hydrate 2 levels deep on initial load for small trees; lazy beyond that
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

    // Find the node in the tree
    function findNode(list: TreeNode[], targetId: string): TreeNode | null {
      for (const n of list) {
        if (n.id === targetId) return n
        const found = findNode(n.children, targetId)
        if (found) return found
      }
      return null
    }

    const target = findNode(nodes, id)
    if (!target) return

    const newCollapsed = !target.collapsed

    // Persist to DB
    try {
      await updateNodeIpc(id, null, null, newCollapsed, null)
    } catch (e) {
      console.error('Failed to persist collapsed state:', e)
      return
    }

    // Update tree: if expanding, load children from IPC; if collapsing, clear children
    function updateInTree(list: TreeNode[]): TreeNode[] {
      return list.map((n) => {
        if (n.id === id) {
          return { ...n, collapsed: newCollapsed, children: newCollapsed ? [] : n.children }
        }
        return { ...n, children: updateInTree(n.children) }
      })
    }

    if (!newCollapsed) {
      // Expanding: load children from IPC
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
        set({ nodes: updateInTree(get().nodes) })
      }
    } else {
      set({ nodes: updateInTree(nodes) })
    }
  },

  zoomIn: async (id: string) => {
    set({ isLoading: true, zoomedNodeId: id })

    try {
      // Build breadcrumb trail
      const trail = await buildBreadcrumbFromId(id)

      // Update window title to zoomed node name
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
        // Zoom back to Home
        set({ breadcrumb: [], zoomedNodeId: null })
        try {
          await getCurrentWindow().setTitle('ai-chat')
        } catch (e) {
          console.warn('setTitle failed (not in Tauri context?):', e)
        }
      } else {
        // Zoom to intermediate ancestor
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
}))
