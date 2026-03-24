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

export async function createNodeIpc(
  parentId: string | null,
  position: string,
  nodeType: NodeType,
  content: JsonValue,
  metadata: JsonValue | null
): Promise<Node> {
  const result = await commands.createNode(parentId, position, nodeType, content, metadata)
  if (result.status === 'error') throw new Error(JSON.stringify(result.error))
  return result.data
}

export async function getNodeIpc(id: string): Promise<Node> {
  const result = await commands.getNode(id)
  if (result.status === 'error') throw new Error(JSON.stringify(result.error))
  return result.data
}

export async function updateNodeIpc(
  id: string,
  content: JsonValue | null,
  position: string | null,
  collapsed: boolean | null,
  metadata: JsonValue | null
): Promise<Node> {
  const result = await commands.updateNode(id, content, position, collapsed, metadata)
  if (result.status === 'error') throw new Error(JSON.stringify(result.error))
  return result.data
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
