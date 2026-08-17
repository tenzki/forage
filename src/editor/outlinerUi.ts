import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { collectBullets, reorderBullet, type MovePlacement } from './outlineModel'

export const OUTLINER_NODE_MENU_EVENT = 'outliner-node-menu'

export interface NodeMenuRequest {
  nodeId: string
  top: number
  left: number
}

interface AgentActivity {
  notes: string[]
  onCancel?: () => void
}

interface OutlinerUiState {
  zoomId: string | null
  query: string
  agentActivity: Record<string, AgentActivity>
}

const uiKey = new PluginKey<OutlinerUiState>('outlinerUi')
const zoomMeta = 'zoom'
const queryMeta = 'query'
const activityMeta = 'agentActivity'

export function getOutlinerUiState(editor: Editor): OutlinerUiState {
  return uiKey.getState(editor.state) ?? { zoomId: null, query: '', agentActivity: {} }
}

export function setZoom(editor: Editor, nodeId: string | null): void {
  editor.view.dispatch(editor.state.tr.setMeta(uiKey, { type: zoomMeta, nodeId }))
}

export function setSearchQuery(editor: Editor, query: string): void {
  editor.view.dispatch(editor.state.tr.setMeta(uiKey, { type: queryMeta, query }))
}

export function setAgentActivity(
  editor: Editor,
  nodeId: string,
  notes: string[] | null,
  onCancel?: () => void,
): void {
  editor.view.dispatch(editor.state.tr.setMeta(uiKey, {
    type: activityMeta,
    nodeId,
    activity: notes === null ? null : { notes, onCancel },
  }))
}

export function toggleCollapsed(editor: Editor, nodeId: string): boolean {
  const entry = collectBullets(editor.state.doc).find((item) => item.id === nodeId)
  if (!entry) return false
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(entry.pos, undefined, {
      ...entry.node.attrs,
      collapsed: !entry.node.attrs.collapsed,
    }),
  )
  return true
}

function hasChildList(node: ProseMirrorNode): boolean {
  for (let index = 0; index < node.childCount; index += 1) {
    if (node.child(index).type.name === 'bulletList') return true
  }
  return false
}

function iconButton(
  label: string,
  className: string,
  text: string,
  preserveEditorSelection = true,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.setAttribute('aria-label', label)
  button.setAttribute('contenteditable', 'false')
  button.textContent = text
  if (preserveEditorSelection) {
    button.addEventListener('mousedown', (event) => event.preventDefault())
  }
  return button
}

function createCollapseButton(editor: Editor, nodeId: string, collapsed: boolean) {
  const label = collapsed ? 'Expand branch' : 'Collapse branch'
  const className = collapsed ? 'bullet-collapse' : 'bullet-collapse is-expanded'
  const button = iconButton(label, className, '')
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    toggleCollapsed(editor, nodeId)
  })
  return button
}

interface PointerDragState {
  startX: number
  startY: number
  started: boolean
  sourceRow: HTMLElement
  targetRow: HTMLElement | null
  targetId: string | null
  placement: MovePlacement
  ghost: HTMLElement | null
  preview: HTMLElement | null
}

function placementAt(row: HTMLElement, clientY: number): MovePlacement {
  const text = row.querySelector<HTMLElement>(':scope > p') ?? row
  const rect = text.getBoundingClientRect()
  const offset = clientY - rect.top
  if (offset < rect.height * 0.3) return 'before'
  if (offset > rect.height * 0.7) return 'after'
  return 'inside'
}

function rowAt(clientX: number, clientY: number, source: HTMLElement): HTMLElement | null {
  const element = document.elementFromPoint(clientX, clientY)
  const row = element?.closest<HTMLElement>('li[data-node-id]') ?? null
  if (!row || row === source || source.contains(row)) return null
  return row
}

function dragLabel(source: HTMLElement): string {
  return source.querySelector(':scope > p')?.textContent?.trim() || 'Untitled'
}

function createDragGhost(source: HTMLElement): HTMLElement {
  const ghost = document.createElement('div')
  ghost.className = 'outline-drag-ghost'
  ghost.textContent = dragLabel(source)
  document.body.append(ghost)
  return ghost
}

function createDropPreview(source: HTMLElement): HTMLElement {
  const preview = document.createElement('div')
  preview.className = 'outline-drop-preview'
  const dot = document.createElement('span')
  dot.className = 'outline-drop-preview-dot'
  const label = document.createElement('span')
  label.textContent = dragLabel(source)
  preview.append(dot, label)
  preview.hidden = true
  document.body.append(preview)
  return preview
}

function positionDropPreview(preview: HTMLElement, row: HTMLElement, placement: MovePlacement): void {
  const text = row.querySelector<HTMLElement>(':scope > p') ?? row
  const textRect = text.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  const nestedOffset = placement === 'inside' ? 26 : 0
  const left = (textRect.left || rowRect.left || 0) + nestedOffset
  const top = placement === 'before'
    ? (textRect.top || rowRect.top || 0) - 28
    : (rowRect.bottom || textRect.bottom || 0)
  const width = textRect.width || rowRect.width || 320
  preview.dataset.placement = placement
  preview.style.left = `${left}px`
  preview.style.top = `${top}px`
  preview.style.width = `${Math.max(120, width - nestedOffset)}px`
  preview.hidden = false
}

function previewContainsPoint(preview: HTMLElement | null, clientX: number, clientY: number): boolean {
  if (!preview || preview.hidden) return false
  const rect = preview.getBoundingClientRect()
  return clientX >= rect.left && clientX <= rect.right
    && clientY >= rect.top && clientY <= rect.bottom
}

function clearPointerDrag(state: PointerDragState, button: HTMLButtonElement): void {
  state.targetRow?.removeAttribute('data-drop-placement')
  state.sourceRow.classList.remove('is-drag-source')
  state.ghost?.remove()
  state.preview?.remove()
  document.body.classList.remove('is-dragging-outline')
  button.setAttribute('aria-grabbed', 'false')
}

function installPointerDrag(button: HTMLButtonElement, editor: Editor, nodeId: string): void {
  button.style.touchAction = 'none'
  button.addEventListener('pointerdown', (downEvent) => {
    if (downEvent.button !== 0) return
    const sourceRow = button.closest<HTMLElement>('li[data-node-id]')
    if (!sourceRow) return
    downEvent.preventDefault()
    downEvent.stopPropagation()
    const state: PointerDragState = {
      startX: downEvent.clientX, startY: downEvent.clientY, started: false,
      sourceRow, targetRow: null, targetId: null, placement: 'after', ghost: null, preview: null,
    }

    const move = (event: PointerEvent) => updatePointerDrag(event, state, button)
    const finish = (event: PointerEvent) => {
      if (state.started) event.preventDefault()
      const targetId = state.targetId
      const placement = state.placement
      if (state.started) button.dataset.suppressZoom = 'true'
      clearPointerDrag(state, button)
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', cancel)
      if (state.started && targetId) reorderBullet(editor, nodeId, targetId, placement)
      window.setTimeout(() => delete button.dataset.suppressZoom, 0)
    }
    const cancel = (event: PointerEvent) => {
      state.targetId = null
      finish(event)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', cancel)
  })
}

function updatePointerDrag(event: PointerEvent, state: PointerDragState, button: HTMLButtonElement): void {
  const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY)
  if (!state.started && distance < 4) return
  event.preventDefault()
  if (!state.started) {
    state.started = true
    state.ghost = createDragGhost(state.sourceRow)
    state.preview = createDropPreview(state.sourceRow)
    state.sourceRow.classList.add('is-drag-source')
    document.body.classList.add('is-dragging-outline')
    button.setAttribute('aria-grabbed', 'true')
  }
  if (state.ghost) {
    state.ghost.style.left = `${event.clientX + 14}px`
    state.ghost.style.top = `${event.clientY + 10}px`
  }
  const hitRow = rowAt(event.clientX, event.clientY, state.sourceRow)
  const row = hitRow ?? (previewContainsPoint(state.preview, event.clientX, event.clientY)
    ? state.targetRow
    : null)
  if (!row) {
    state.targetRow?.removeAttribute('data-drop-placement')
    state.targetRow = null
    state.targetId = null
    if (state.preview) state.preview.hidden = true
    return
  }
  const placement = placementAt(row, event.clientY)
  if (row === state.targetRow && placement === state.placement) return
  state.targetRow?.removeAttribute('data-drop-placement')
  state.targetRow = row
  state.targetId = row.dataset.nodeId ?? null
  state.placement = placement
  row.dataset.dropPlacement = placement
  if (state.preview) positionDropPreview(state.preview, row, placement)
}

function createBulletButton(editor: Editor, nodeId: string): HTMLButtonElement {
  const button = iconButton('Zoom into bullet; drag to move', 'bullet-dot', '', false)
  button.setAttribute('aria-grabbed', 'false')
  button.title = 'Drag to move · Click to zoom'
  installPointerDrag(button, editor, nodeId)
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    if (button.dataset.suppressZoom === 'true') return
    setZoom(editor, nodeId)
  })
  return button
}

function createMenuButton(nodeId: string): HTMLButtonElement {
  const button = iconButton('Actions for bullet', 'bullet-menu', '•••')
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    const rect = button.getBoundingClientRect()
    window.dispatchEvent(new CustomEvent<NodeMenuRequest>(OUTLINER_NODE_MENU_EVENT, {
      detail: { nodeId, top: rect.bottom + 4, left: rect.left },
    }))
  })
  return button
}

function createControls(editor: Editor, node: ProseMirrorNode): HTMLElement {
  const nodeId = node.attrs.nodeId as string
  const controls = document.createElement('span')
  controls.className = 'bullet-controls'
  controls.setAttribute('contenteditable', 'false')
  controls.append(createMenuButton(nodeId))
  if (hasChildList(node)) {
    controls.append(createCollapseButton(editor, nodeId, Boolean(node.attrs.collapsed)))
  } else {
    const spacer = document.createElement('span')
    spacer.className = 'bullet-collapse-spacer'
    controls.append(spacer)
  }
  controls.append(createBulletButton(editor, nodeId))
  return controls
}

function nodeClasses(
  entry: ReturnType<typeof collectBullets>[number],
  ui: OutlinerUiState,
): string[] {
  const classes: string[] = []
  if (entry.node.attrs.collapsed) classes.push('is-collapsed')
  if (!ui.zoomId) return classes
  if (entry.id === ui.zoomId) classes.push('zoom-root')
  else if (entry.ancestorIds.includes(ui.zoomId)) classes.push('zoom-descendant')
  return classes
}

function createActivityWidget(activity: AgentActivity): HTMLElement {
  const status = document.createElement('span')
  status.className = 'agent-activity'
  status.setAttribute('contenteditable', 'false')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  if (activity.notes.length) {
    const notes = document.createElement('span')
    notes.className = 'agent-activity-notes'
    for (const note of activity.notes) {
      const line = document.createElement('span')
      line.className = 'agent-activity-line'
      line.textContent = note
      notes.append(line)
    }
    status.append(notes)
  } else {
    status.classList.add('is-streaming')
  }
  if (activity.onCancel) status.append(createStopButton(activity.onCancel))
  return status
}

function createStopButton(onCancel: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'agent-stop'
  button.textContent = 'Stop'
  button.setAttribute('aria-label', 'Stop generation')
  button.setAttribute('contenteditable', 'false')
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    button.disabled = true
    button.textContent = 'Stopping…'
    onCancel()
  })
  return button
}

function addSearchHighlights(
  decorations: Decoration[],
  entry: ReturnType<typeof collectBullets>[number],
  query: string,
) {
  const paragraph = entry.node.firstChild
  if (!paragraph || !query) return
  const lowerText = paragraph.textContent.toLocaleLowerCase()
  const lowerQuery = query.toLocaleLowerCase()
  let index = lowerText.indexOf(lowerQuery)
  while (index >= 0) {
    const from = entry.pos + 2 + index
    decorations.push(Decoration.inline(from, from + query.length, { class: 'search-match' }))
    index = lowerText.indexOf(lowerQuery, index + Math.max(query.length, 1))
  }
}

function buildDecorations(editor: Editor): DecorationSet {
  const ui = getOutlinerUiState(editor)
  const entries = collectBullets(editor.state.doc)
  const zoomTarget = entries.find((entry) => entry.id === ui.zoomId)
  const zoomPath = new Set(zoomTarget ? [...zoomTarget.ancestorIds, zoomTarget.id] : [])
  const decorations: Decoration[] = []
  for (const entry of entries) {
    const classes = nodeClasses(entry, ui)
    const activity = ui.agentActivity[entry.id]
    if (activity?.notes.length) classes.push('is-agent-active')
    if (ui.zoomId && !zoomPath.has(entry.id) && !entry.ancestorIds.includes(ui.zoomId)) {
      classes.push('zoom-hidden')
    } else if (ui.zoomId && zoomPath.has(entry.id) && entry.id !== ui.zoomId) {
      classes.push('zoom-ancestor')
    }
    if (classes.length) {
      decorations.push(Decoration.node(entry.pos, entry.pos + entry.node.nodeSize, { class: classes.join(' ') }))
    }
    decorations.push(
      Decoration.widget(entry.pos + 1, () => createControls(editor, entry.node), {
        key: `controls-${entry.id}-${Boolean(entry.node.attrs.collapsed)}`,
        side: -1,
      }),
    )
    if (activity && (activity.notes.length || activity.onCancel)) {
      decorations.push(Decoration.widget(
        entry.pos + 2,
        () => createActivityWidget(activity),
        { key: `activity-${entry.id}-${activity.notes.join('|')}`, side: -1 },
      ))
    }
    addSearchHighlights(decorations, entry, ui.query.trim())
  }
  return DecorationSet.create(editor.state.doc, decorations)
}

export const OutlinerUi = Extension.create({
  name: 'outlinerUi',

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin<OutlinerUiState>({
        key: uiKey,
        state: {
          init: () => ({ zoomId: null, query: '', agentActivity: {} }),
          apply: (transaction, previous) => {
            const meta = transaction.getMeta(uiKey) as
              | { type: string; nodeId?: string | null; query?: string; activity?: AgentActivity | null }
              | undefined
            if (meta?.type === zoomMeta) return { ...previous, zoomId: meta.nodeId ?? null }
            if (meta?.type === queryMeta) return { ...previous, query: meta.query ?? '' }
            if (meta?.type === activityMeta && meta.nodeId) {
              const agentActivity = { ...previous.agentActivity }
              if (meta.activity && (meta.activity.notes.length || meta.activity.onCancel)) {
                agentActivity[meta.nodeId] = meta.activity
              } else {
                delete agentActivity[meta.nodeId]
              }
              return { ...previous, agentActivity }
            }
            if (previous.zoomId && !collectBullets(transaction.doc).some((e) => e.id === previous.zoomId)) {
              return { ...previous, zoomId: null }
            }
            return previous
          },
        },
        props: {
          decorations: (_state) => buildDecorations(editor),
        },
      }),
    ]
  },
})
