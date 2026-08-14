// Persist the outline as a single JSON file inside the iCloud Drive folder.
// macOS syncs the file across the user's devices — no custom sync code (INFR-03).
//
// Path: ~/Library/Mobile Documents/com~apple~CloudDocs/AIChat/tree.json
// The fs scope in src-tauri/capabilities/default.json must allow this folder.

import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs'
import { homeDir, join } from '@tauri-apps/api/path'
import type { OutlineDoc } from '../types/tree'

const ICLOUD_REL = 'Library/Mobile Documents/com~apple~CloudDocs/AIChat'
const FILE_NAME = 'tree.json'

async function dirPath(): Promise<string> {
  return join(await homeDir(), ICLOUD_REL)
}

async function filePath(): Promise<string> {
  return join(await dirPath(), FILE_NAME)
}

/** Read the outline from disk, or null if no file exists yet (first run). */
export async function loadOutline(): Promise<OutlineDoc | null> {
  const path = await filePath()
  if (!(await exists(path))) return null
  try {
    const raw = await readTextFile(path)
    const parsed = JSON.parse(raw) as OutlineDoc
    if (parsed && parsed.version === 1 && parsed.doc) return parsed
    console.error('[persistence] unexpected file shape, ignoring:', parsed)
    return null
  } catch (e) {
    console.error('[persistence] failed to read/parse outline:', e)
    return null
  }
}

/** Write the outline to disk, creating the iCloud folder if needed. */
export async function saveOutline(outline: OutlineDoc): Promise<void> {
  const dir = await dirPath()
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true })
  }
  await writeTextFile(await filePath(), JSON.stringify(outline))
}

/** Debounced saver: coalesces rapid edits into one write. */
export function createDebouncedSaver(delayMs = 600) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: OutlineDoc | null = null

  const flush = async () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending) {
      const toWrite = pending
      pending = null
      await saveOutline(toWrite)
    }
  }

  const schedule = (outline: OutlineDoc) => {
    pending = outline
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void flush()
    }, delayMs)
  }

  return { schedule, flush }
}
