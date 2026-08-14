// Single-document outliner model.
//
// Source of truth is one ProseMirror/TipTap document: a bulletList whose
// listItems can nest arbitrarily. Each listItem carries stable attributes so
// the agent, zoom, and search can reference a bullet without positional ids.
//
// We persist the raw ProseMirror JSON (see src/persistence). No SQLite, no IPC.

/** ProseMirror JSON is an untyped tree of nodes; alias for readability. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Distinguishes user-written bullets from agent-generated ones (EDIT-04). */
export type NodeType = 'user' | 'ai'

/** Attributes we attach to every listItem in the document. */
export interface BulletAttrs {
  nodeId: string
  nodeType: NodeType
  collapsed: boolean
}

/** The persisted document envelope written to the iCloud Drive file. */
export interface OutlineDoc {
  version: 1
  /** Raw ProseMirror doc JSON (a `doc` node containing one `bulletList`). */
  doc: JsonValue
}

/** Stable id generator for bullets. crypto.randomUUID is available in the webview. */
export function newNodeId(): string {
  return crypto.randomUUID()
}

/** Extract plain text from a ProseMirror node JSON (recursive). Used by search/agent. */
export function extractText(node: JsonValue): string {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return ''
  const n = node as Record<string, JsonValue>
  if (n['type'] === 'text' && typeof n['text'] === 'string') return n['text']
  const content = n['content']
  if (!Array.isArray(content)) return ''
  return content.map(extractText).join('')
}
