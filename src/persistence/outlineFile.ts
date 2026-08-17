// Persist the outline as a single JSON file inside the iCloud Drive folder.
// macOS syncs the file across the user's devices — no custom sync code (INFR-03).

import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs'
import { homeDir, join } from '@tauri-apps/api/path'
import type {
  JsonValue,
  LegacyOutlineDoc,
  OutlineDoc,
  OutlineShortcut,
  TrashEntry,
} from '../types/tree'

const ICLOUD_REL = 'Library/Mobile Documents/com~apple~CloudDocs/AIChat'
const FILE_NAME = 'tree.json'

async function dirPath(): Promise<string> {
  return join(await homeDir(), ICLOUD_REL)
}

async function filePath(): Promise<string> {
  return join(await dirPath(), FILE_NAME)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validPmNode(value: unknown): boolean {
  if (!isObject(value) || typeof value.type !== 'string') return false
  if (value.content === undefined) return true
  return Array.isArray(value.content) && value.content.every(validPmNode)
}

function validShortcut(value: unknown): value is OutlineShortcut {
  return isObject(value)
    && (value.type === 'node' || value.type === 'tag')
    && typeof value.target === 'string'
    && value.target.trim().length > 0
}

function validTrashEntry(value: unknown): value is TrashEntry {
  if (!isObject(value) || !isObject(value.node) || !isObject(value.node.attrs)) return false
  return typeof value.id === 'string'
    && typeof value.deletedAt === 'string'
    && (value.originalParentId === null || typeof value.originalParentId === 'string')
    && Number.isInteger(value.originalIndex)
    && Number(value.originalIndex) >= 0
    && value.node.type === 'listItem'
    && typeof value.node.attrs.nodeId === 'string'
    && validPmNode(value.node)
}

/** Validate and migrate persisted data without trusting arbitrary JSON. */
export function normalizeOutline(value: unknown): OutlineDoc {
  if (!isObject(value) || !isObject(value.doc) || value.doc.type !== 'doc' || !validPmNode(value.doc)) {
    throw new Error('The outline file does not contain a valid document.')
  }
  if (value.version === 1) {
    const legacy = value as unknown as LegacyOutlineDoc
    return { version: 3, doc: legacy.doc, trash: [], shortcuts: [] }
  }
  if (!Array.isArray(value.trash) || !value.trash.every(validTrashEntry)) {
    throw new Error('The outline file uses an unsupported or invalid format.')
  }
  if (value.version === 2) {
    return { version: 3, doc: value.doc as JsonValue, trash: value.trash, shortcuts: [] }
  }
  if (value.version !== 3
    || !Array.isArray(value.shortcuts)
    || !value.shortcuts.every(validShortcut)) {
    throw new Error('The outline file uses an unsupported or invalid format.')
  }
  return {
    version: 3,
    doc: value.doc as JsonValue,
    trash: value.trash,
    shortcuts: value.shortcuts,
  }
}

/** Read and migrate the outline, or return null on the first run. */
export async function loadOutline(): Promise<OutlineDoc | null> {
  const path = await filePath()
  if (!(await exists(path))) return null
  let raw: string
  try {
    raw = await readTextFile(path)
  } catch {
    throw new Error('Could not read the outline file.')
  }
  try {
    return normalizeOutline(JSON.parse(raw))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('The outline file contains invalid JSON.')
    }
    throw error
  }
}

/** Write the outline, creating the iCloud folder if needed. */
export async function saveOutline(outline: OutlineDoc): Promise<void> {
  const dir = await dirPath()
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  await writeTextFile(await filePath(), JSON.stringify(outline))
}

export interface DebouncedSaver {
  schedule: (outline: OutlineDoc) => void
  flush: () => Promise<void>
  hasPending: () => boolean
}

/** Coalesces edits, retains failed writes, and reports timer failures. */
export function createDebouncedSaver(
  delayMs = 600,
  onError: (error: unknown) => void = (error) => console.error('[persistence] save failed:', error),
  onSaved: () => void = () => undefined,
): DebouncedSaver {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: OutlineDoc | null = null

  const flush = async () => {
    if (timer) clearTimeout(timer)
    timer = null
    const toWrite = pending
    if (!toWrite) return
    await saveOutline(toWrite)
    if (pending === toWrite) pending = null
    onSaved()
  }

  const schedule = (outline: OutlineDoc) => {
    pending = outline
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void flush().catch(onError), delayMs)
  }

  return { schedule, flush, hasPending: () => pending !== null }
}
