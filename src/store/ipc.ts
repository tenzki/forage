import { commands } from '../lib/bindings'
import { invoke } from '@tauri-apps/api/core'
import type { Node, JsonValue, NodeType } from '../lib/bindings'

/**
 * Thin async wrappers around bindings.ts commands that unwrap Result<T, E>
 * and throw a standard Error on failure.
 */

export async function loadChildren(parentId: string | null): Promise<Node[]> {
  const result = await commands.getChildren(parentId)
  if (result.status === 'error') throw new Error(JSON.stringify(result.error))
  return result.data
}

/**
 * Create a new node.
 * Uses direct invoke (not bindings) because bindings.ts regenerates only on
 * cargo tauri dev/build and the Rust signature now includes contentText.
 */
export async function createNodeIpc(
  parentId: string | null,
  position: string,
  nodeType: NodeType,
  content: JsonValue,
  metadata: JsonValue | null,
  contentText: string | null = null
): Promise<Node> {
  try {
    const data = await invoke<Node>('create_node', {
      parentId,
      position,
      nodeType,
      content,
      metadata,
      contentText,
    })
    return data
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : JSON.stringify(e))
  }
}

export async function getNodeIpc(id: string): Promise<Node> {
  const result = await commands.getNode(id)
  if (result.status === 'error') throw new Error(JSON.stringify(result.error))
  return result.data
}

/**
 * Update a node's fields.
 * Uses direct invoke (not bindings) because bindings.ts regenerates only on
 * cargo tauri dev/build and the Rust signature now includes contentText.
 */
export async function updateNodeIpc(
  id: string,
  content: JsonValue | null,
  position: string | null,
  collapsed: boolean | null,
  metadata: JsonValue | null,
  contentText: string | null = null
): Promise<Node> {
  try {
    const data = await invoke<Node>('update_node', {
      id,
      content,
      position,
      collapsed,
      metadata,
      contentText,
    })
    return data
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : JSON.stringify(e))
  }
}

export async function deleteNodeIpc(id: string): Promise<void> {
  const result = await commands.deleteNode(id)
  if (result.status === 'error') throw new Error(JSON.stringify(result.error))
}

/**
 * Move a node to a new parent at a new position.
 * move_node was added in Plan 01 Task 2 but bindings.ts is regenerated on
 * cargo tauri dev/build — invoke directly until next regeneration.
 */
export async function moveNodeIpc(
  id: string,
  newParentId: string | null,
  newPosition: string
): Promise<Node> {
  try {
    const data = await invoke<Node>('move_node', {
      id,
      newParentId,
      newPosition,
    })
    return data
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : JSON.stringify(e))
  }
}

/**
 * Change the node_type of a node.
 * Primary use: converting agent_response nodes to regular notes ("Make mine").
 * Uses direct invoke because bindings.ts regenerates only on cargo tauri dev/build.
 */
export async function changeNodeTypeIpc(id: string, nodeType: string): Promise<void> {
  try {
    await invoke('change_node_type', { id, nodeType })
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : JSON.stringify(e))
  }
}

// ─── Search IPC ───────────────────────────────────────────────────────────────

export interface SearchResult {
  id: string
  parentId: string | null
  nodeType: string
  snippet: string
}

export interface AncestorNode {
  id: string
  name: string
}

/**
 * Search nodes using FTS5 full-text search.
 * Returns up to 20 results with highlighted snippets.
 */
export async function searchNodesIpc(query: string): Promise<SearchResult[]> {
  try {
    const data = await invoke<SearchResult[]>('search_nodes', { query })
    return data
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : JSON.stringify(e))
  }
}

/**
 * Get ancestors of a node for breadcrumb display.
 * Returns ordered list from root to the node's direct parent.
 */
export async function getAncestorsIpc(nodeId: string): Promise<AncestorNode[]> {
  try {
    const data = await invoke<AncestorNode[]>('get_ancestors', { nodeId })
    return data
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : JSON.stringify(e))
  }
}
