// Bridges the Codex stream to the single TipTap document: build branch
// context from ancestors, insert an AI-styled child bullet under the current
// one, and stream text into it.
//
// Two rules shape this file:
//   - The agent emits one idea per line, so each line becomes its own bullet.
//     A single text node would collapse the newlines when rendered as HTML.
//   - Generation must never disturb the user. The insert does not move the
//     selection, and every streaming write uses addToHistory:false so the whole
//     generation collapses into the one undo step created by the insert.

import type { Editor } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { setAgentActivity } from '../editor/outlinerUi'
import { newNodeId } from '../types/tree'
import { generate, type CodexAuthConfig } from './client'
import type { Skill } from './skills'
import type { CustomHttpToolConfig } from './tools'

/** Text of the listItems enclosing the cursor, outer-to-inner. */
export function ancestorContext(editor: Editor): string[] {
  const { $from } = editor.state.selection
  const texts: string[] = []
  for (let d = 1; d <= $from.depth; d++) {
    const node = $from.node(d)
    if (node.type.name === 'listItem') {
      const t = node.firstChild?.textContent?.trim()
      if (t) texts.push(t)
    }
  }
  return texts
}

/** Find the listItem enclosing the cursor; returns its position + node. */
function currentListItem(editor: Editor) {
  const { $from } = editor.state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'listItem') {
      return { depth: d, pos: $from.before(d), node: $from.node(d) }
    }
  }
  return null
}

/** Replace the text of the bullet the cursor is in (used to set the prompt note). */
export function setCurrentBulletText(
  editor: Editor,
  text: string,
  moveCursorToEnd = false,
): void {
  const li = currentListItem(editor)
  if (!li) return
  const para = li.node.firstChild
  const paraStart = li.pos + 2
  const size = para?.content.size ?? 0
  const tr = editor.state.tr
  if (text.length) {
    tr.replaceWith(paraStart, paraStart + size, editor.schema.text(text))
  } else if (size > 0) {
    tr.delete(paraStart, paraStart + size)
  }
  if (moveCursorToEnd) {
    tr.setSelection(TextSelection.create(tr.doc, paraStart + text.length))
  }
  editor.view.dispatch(tr)
}

/**
 * Insert a bulletList holding one empty AI bullet under the current listItem.
 * Returns the nodeId of that bullet, which identifies the list for later writes.
 * The selection is left untouched so the user keeps typing where they were.
 */
export function insertAiChild(editor: Editor): string | null {
  const li = currentListItem(editor)
  if (!li) return null
  const nodeId = newNodeId()
  // Position just inside the end of the current listItem (after its paragraph).
  const insertPos = li.pos + li.node.nodeSize - 1
  editor
    .chain()
    .insertContentAt(
      insertPos,
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            attrs: { nodeId, nodeType: 'ai' },
            content: [{ type: 'paragraph' }],
          },
        ],
      },
      { updateSelection: false },
    )
    .run()
  return nodeId
}

/** Locate the bulletList whose first child carries `rootNodeId`. */
function findAiList(
  editor: Editor,
  rootNodeId: string,
): { pos: number; node: ProseMirrorNode } | null {
  let found: { pos: number; node: ProseMirrorNode } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name !== 'bulletList') return undefined
    node.forEach((child) => {
      if (child.type.name === 'listItem' && child.attrs.nodeId === rootNodeId) {
        found = { pos, node }
      }
    })
    return undefined
  })
  return found
}

/** Split streamed text into the lines that should become bullets. */
function toLines(text: string): string[] {
  // Models often separate ideas with blank lines. Empty list items create
  // orphan dots, so keep only visible outline content.
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length ? lines : ['']
}

/**
 * Materialise the agent's output so far as one AI bullet per line, replacing
 * whatever the previous delta wrote. Bullet ids are stable across deltas, and
 * the write is kept out of the undo history and away from the selection.
 */
export function writeAiText(
  editor: Editor,
  rootNodeId: string,
  text: string,
): void {
  const list = findAiList(editor, rootNodeId)
  if (!list) return

  const { schema } = editor
  const existingIds: string[] = []
  list.node.forEach((child) => existingIds.push(child.attrs.nodeId))

  const items = toLines(text).map((line, i) =>
    schema.nodes.listItem.create(
      { nodeId: existingIds[i] ?? newNodeId(), nodeType: 'ai' },
      schema.nodes.paragraph.create(null, line ? schema.text(line) : null),
    ),
  )

  const tr = editor.state.tr
  tr.replaceWith(
    list.pos,
    list.pos + list.node.nodeSize,
    schema.nodes.bulletList.create(list.node.attrs, items),
  )
  tr.setMeta('addToHistory', false)
  editor.view.dispatch(tr)
}

export interface Generation {
  promise: Promise<void>
  cancel: () => void
}

/**
 * Run a skill, streaming its output into new AI bullets under the cursor.
 * Returns a handle whose cancel() aborts the in-flight request.
 */
export function runSkillIntoEditor(
  editor: Editor,
  auth: CodexAuthConfig,
  skill: Skill,
  prompt: string,
  enabledToolIds: string[] = [],
  customTools: CustomHttpToolConfig[] = [],
): Generation {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const context = ancestorContext(editor)
  const nodeId = insertAiChild(editor)

  const promise = (async () => {
    if (!nodeId) throw new Error('Could not find a bullet to generate under.')
    try {
      setAgentActivity(editor, nodeId, ['Thinking…'], cancel)
      await generate(
        auth,
        { skill, prompt, context, enabledToolIds, customTools },
        {
          signal: controller.signal,
          onDelta: (textSoFar) => {
            setAgentActivity(editor, nodeId, [], cancel)
            writeAiText(editor, nodeId, textSoFar)
          },
          onToolActivity: (notes) => setAgentActivity(editor, nodeId, notes, cancel),
        },
      )
      setAgentActivity(editor, nodeId, null)
    } catch (e) {
      setAgentActivity(editor, nodeId, null)
      if (controller.signal.aborted) {
        writeAiText(editor, nodeId, '[cancelled]')
      } else {
        const msg = e instanceof Error ? e.message : String(e)
        writeAiText(editor, nodeId, `[error: ${msg}]`)
      }
    }
  })()

  return { promise, cancel }
}
