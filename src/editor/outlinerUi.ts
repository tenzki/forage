import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { collectBullets, reorderBullet } from './outlineModel'

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

function iconButton(label: string, className: string, text: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.setAttribute('aria-label', label)
  button.setAttribute('contenteditable', 'false')
  button.textContent = text
  button.addEventListener('mousedown', (event) => event.preventDefault())
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

function createBulletButton(editor: Editor, nodeId: string): HTMLButtonElement {
  const button = iconButton('Zoom into bullet', 'bullet-dot', '')
  button.draggable = true
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    setZoom(editor, nodeId)
  })
  button.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData('application/x-outline-node', nodeId)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  })
  return button
}

function addDropHandlers(button: HTMLButtonElement, editor: Editor, targetId: string) {
  button.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('application/x-outline-node')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  })
  button.addEventListener('drop', (event) => {
    const sourceId = event.dataTransfer?.getData('application/x-outline-node')
    if (!sourceId) return
    event.preventDefault()
    const rect = button.getBoundingClientRect()
    reorderBullet(editor, sourceId, targetId, event.clientY >= rect.top + rect.height / 2)
  })
}

function createControls(editor: Editor, node: ProseMirrorNode): HTMLElement {
  const nodeId = node.attrs.nodeId as string
  const controls = document.createElement('span')
  controls.className = 'bullet-controls'
  controls.setAttribute('contenteditable', 'false')
  if (hasChildList(node)) {
    controls.append(createCollapseButton(editor, nodeId, Boolean(node.attrs.collapsed)))
  } else {
    const spacer = document.createElement('span')
    spacer.className = 'bullet-collapse-spacer'
    controls.append(spacer)
  }
  const bullet = createBulletButton(editor, nodeId)
  addDropHandlers(bullet, editor, nodeId)
  controls.append(bullet)
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
