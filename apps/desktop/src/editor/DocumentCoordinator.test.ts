import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialOutlineState, reduceOutlineEvent } from '@forage/domain'
import { DocumentCoordinator } from './DocumentCoordinator'
import { documentEditor } from './documentAccess'
import { captureDocumentEvent, finalizeDocumentEvent, type CapturedEditorEvent } from './eventCapture'
import { dispatchPersistentUndo, dispatchPersistentRedo, rebuildPersistentHistory, recordDocumentChange, type PersistentHistoryState } from './persistentHistory'
import { collectBullets, findBullet, trashBullet, restoreBullet } from './outlineModel'
import { getOutlinerUiState, setAgentActivity, setHideCompleted, setSearchQuery, setZoom, toggleCollapsed } from './outlinerUi'
import { showSkillContext } from './contextPreview'
import { insertAiChildUnder, writeAiText } from '../agent/insertIntoEditor'
import { setEditorMutationLocked } from './extensions'
import type { Editor } from '@tiptap/core'
import type { JsonValue } from '../types/tree'

const disposal: Array<() => void> = []
afterEach(() => { disposal.splice(0).reverse().forEach(fn => fn()) })
const item = (id: string, text: string) => ({ type: 'listItem', attrs: { nodeId: id },
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const content = { type: 'doc', content: [{ type: 'bulletList', content: [item('alpha', 'Alpha'), item('beta', 'Beta')] }] }
function setup(retainedRevisions?: number) {
  const events: CapturedEditorEvent[] = []
  const batches: unknown[][] = []
  const history: PersistentHistoryState = { undo: [], redo: [] }
  let group = 0
  let id = 0
  const recovery = vi.fn()
  const coordinator = new DocumentCoordinator(content as JsonValue, {
    retainedRevisions,
    onPaneSwitch: () => { group++ },
    onRecovery: recovery,
    onTransaction: (root, appended) => {
      batches.push([root, ...appended])
      const event = captureDocumentEvent(root, appended, { outlineId: 'outline', actorId: 'actor', deviceId: 'device',
        baseRevision: events.length, nextEventId: () => `e-${++id}`, nextChangeGroupId: () => `g-${group}` })
      if (event) { events.push(event); if (event.type === 'document.steps_applied') recordDocumentChange(history, event) }
    },
  })
  disposal.push(() => coordinator.destroy())
  const view = (id: string) => {
    const element = document.body.appendChild(document.createElement('div'))
    disposal.push(() => element.remove())
    return coordinator.createView(id, { element })
  }
  const a = view('a')
  const b = view('b')
  const insert = (editor: Editor, text: string, id = 'alpha') => {
    editor.view.dispatch(editor.state.tr.insertText(text, findBullet(editor.state.doc, id)!.pos + 2))
  }
  return { coordinator, a, b, events, batches, history, insert, view, recovery }
}

describe('production canonical document coordination', () => {
  it('uses a shared schema, canonical normalization and one capture for two TipTap adapters', () => {
    const { coordinator, a, b, events, batches } = setup()
    expect(a.schema).toBe(coordinator.editor.schema)
    expect(a.extensionManager.schema).toBe(b.schema)
    const node = a.schema.nodes.listItem.create(null, a.schema.nodes.paragraph.create())
    a.view.dispatch(a.state.tr.insert(a.state.doc.content.size - 1, node))
    expect(events).toHaveLength(1)
    expect(batches[0].length).toBe(2)
    const ids = collectBullets(a.state.doc).map(node => node.id)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('alpha')
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
    expect(a.state.doc.eq(coordinator.editor.state.doc)).toBe(true)
  })

  it('uses canonical mark types in pane commands and preserves local command capability', () => {
    const { coordinator, a, b } = setup()
    const pos = findBullet(a.state.doc, 'alpha')!.pos + 2
    a.commands.setTextSelection({ from: pos, to: pos + 5 })
    expect(a.can().toggleBold()).toBe(true)
    a.chain().toggleBold().run()
    a.state.doc.descendants(node => {
      if (node.isText && node.text === 'Alpha') expect(node.marks[0].type).toBe(coordinator.editor.schema.marks.bold)
    })
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
    a.state.doc.check()
  })

  it('runs external paste rules once and preserves internal clipboard provenance', () => {
    const { coordinator, a, b, events, batches } = setup()
    const paste = (text: string, html: string) => {
      const event = new Event('paste') as ClipboardEvent
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => html } })
      a.view.props.handleDOMEvents!.paste!(a.view, event)
      const pos = findBullet(a.state.doc, 'alpha')!.pos + 2
      a.view.dispatch(a.state.tr.insertText(text, pos).setMeta('uiEvent', 'paste'))
    }
    paste('**external** ', '')
    expect(findBullet(b.state.doc, 'alpha')!.node.textContent).toContain('external Alpha')
    expect(findBullet(b.state.doc, 'alpha')!.node.textContent).not.toContain('**external**')
    expect(batches[0].length).toBeGreaterThan(1)
    paste('**literal** ', '<p data-pm-slice="0 0 []">**literal**</p>')
    expect(findBullet(b.state.doc, 'alpha')!.node.textContent).toContain('**literal**')
    expect(events).toHaveLength(2)
    expect(a.state.doc.eq(coordinator.editor.state.doc)).toBe(true)
  })

  it('projects asset references once and leaves each pane scroll position untouched', () => {
    const { coordinator, a, b, events } = setup()
    const assetId = 'a'.repeat(64)
    a.view.dom.scrollTop = 120
    b.view.dom.scrollTop = 280
    const image = a.schema.nodes.generatedImage.create({ assetId, alt: 'Shared image' })
    const item = a.schema.nodes.generatedImageItem.create(null, image)
    a.view.dispatch(a.state.tr.insert(a.state.doc.content.size - 1, item))
    expect(events).toHaveLength(1)
    for (const editor of [a, b]) {
      expect(editor.view.dom.querySelectorAll(`img[data-asset-id="${assetId}"]`)).toHaveLength(1)
      expect(editor.state.doc.eq(coordinator.editor.state.doc)).toBe(true)
    }
    expect(a.view.dom.scrollTop).toBe(120)
    expect(b.view.dom.scrollTop).toBe(280)
  })

  it('keeps search, navigation, filters, previews and focus local while collapse is shared', () => {
    const { a, b, events, insert } = setup()
    setSearchQuery(a, 'alpha')
    setZoom(a, 'alpha')
    setHideCompleted(a, true)
    showSkillContext(a, { invocationNodeId: 'alpha', localNodeIds: ['alpha'] })
    expect(getOutlinerUiState(b)).toMatchObject({ query: '', zoomId: null, hideCompleted: false, backStack: [] })
    expect(a.view.dom.querySelector('.skill-context-invocation')).not.toBeNull()
    expect(b.view.dom.querySelector('.skill-context-invocation')).toBeNull()
    expect(events).toHaveLength(0)
    const selection = findBullet(b.state.doc, 'alpha')!.pos + 5
    b.commands.setTextSelection(selection)
    a.view.focus()
    insert(a, '++')
    expect(b.state.selection.from).toBe(selection + 2)
    expect(document.activeElement).toBe(a.view.dom)
    expect(getOutlinerUiState(a)).toMatchObject({ query: 'alpha', zoomId: 'alpha', hideCompleted: true })
    toggleCollapsed(a, 'alpha')
    expect(findBullet(b.state.doc, 'alpha')!.node.attrs.collapsed).toBe(true)
  })

  it('broadcasts shared activity and streaming decorations, including to newly mounted views', () => {
    const { coordinator, a, b, events, view } = setup()
    const output = insertAiChildUnder(documentEditor(a), 'alpha')!
    setAgentActivity(coordinator.editor, output, ['Thinking…'])
    writeAiText(coordinator.editor, output, 'Shared generated text', '')
    expect(getOutlinerUiState(a).agentActivity[output].notes).toEqual(['Thinking…'])
    expect(getOutlinerUiState(b).agentActivity[output].notes).toEqual(['Thinking…'])
    const c = view('c')
    expect(getOutlinerUiState(c).agentActivity[output].notes).toEqual(['Thinking…'])
    expect(c.view.dom.querySelector('.t-stream-w')).not.toBeNull()
    expect(a.state.doc.eq(b.state.doc) && b.state.doc.eq(c.state.doc)).toBe(true)
    expect(events).toHaveLength(2)
  })

  it('rebases stale steps and preserves arbitrary mutation metadata', () => {
    const { coordinator, a, b, insert, batches } = setup()
    const base = coordinator.revision
    const stale = b.state.tr.insertText('B', findBullet(b.state.doc, 'alpha')!.pos + 4)
      .setMeta('forageOrigin', 'agent').setMeta('forageChangeGroup', 'run-1').setMeta('customDomainMetadata', { key: 'retained' })
    insert(a, 'A')
    expect(coordinator.dispatch('b', stale, base)).toBe(true)
    const root = batches[1][0] as typeof stale
    expect(root.getMeta('forageOrigin')).toBe('agent')
    expect(root.getMeta('forageChangeGroup')).toBe('run-1')
    expect(root.getMeta('customDomainMetadata')).toEqual({ key: 'retained' })
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
  })

  it('bounds stale mapping retention and preserves expired input for recovery', () => {
    const { coordinator, a, b, insert, recovery } = setup(1)
    const stale = b.state.tr.insertText('retained', findBullet(b.state.doc, 'alpha')!.pos + 2)
    insert(a, '1')
    insert(a, '2')
    expect(coordinator.dispatch('b', stale, 0)).toBe(false)
    expect(recovery).toHaveBeenCalledOnce()
    expect(coordinator.recovery.get('b')!.pending.doc.textContent).toContain('retained')
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
  })

  it('defers composing views, reconciles replacements and retains focus', () => {
    const { coordinator, a, b, insert, events } = setup()
    const pos = findBullet(b.state.doc, 'alpha')!.pos + 3
    b.view.focus()
    coordinator.beginComposition('b')
    b.view.dispatch(b.state.tr.insertText('に', pos))
    insert(a, 'other')
    b.view.dispatch(b.state.tr.insertText('日本', pos, pos + 1))
    expect(b.state.doc.textContent).not.toContain('other')
    expect(coordinator.endComposition('b')).toBe(true)
    expect(a.state.doc.textContent).toContain('日本')
    expect(a.state.doc.textContent).toContain('other')
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
    expect(document.activeElement).toBe(b.view.dom)
    expect(events).toHaveLength(2)
  })

  it('finishes buffered composition when its pane closes', () => {
    const { coordinator, a, b, events } = setup()
    coordinator.beginComposition('a')
    a.view.dispatch(a.state.tr.insertText('日本', findBullet(a.state.doc, 'alpha')!.pos + 2))
    a.destroy()
    expect(b.state.doc.textContent).toContain('日本')
    expect(events).toHaveLength(1)
    expect(coordinator.editor.isDestroyed).toBe(false)
  })

  it('retains conflicting composition for recovery after its pane closes', () => {
    const { coordinator, a, b, insert, recovery } = setup(1)
    coordinator.beginComposition('a')
    a.view.dispatch(a.state.tr.insertText('日本', findBullet(a.state.doc, 'alpha')!.pos + 2))
    insert(b, '1')
    insert(b, '2')
    expect(coordinator.endComposition('a')).toBe(false)
    expect(a.state.doc.textContent).toContain('日本')
    a.destroy()
    expect(recovery).toHaveBeenCalled()
    expect(coordinator.recovery.get('a')!.pending.doc.textContent).toContain('日本')
    expect(coordinator.editor.state.doc.eq(b.state.doc)).toBe(true)
  })

  it('rejects locked document changes from every pane at the canonical boundary', () => {
    const { coordinator, a, b, insert, events, recovery } = setup()
    const before = coordinator.editor.state.doc
    setEditorMutationLocked(a, true)
    insert(b, 'blocked')
    expect(coordinator.editor.state.doc.eq(before)).toBe(true)
    expect(events).toHaveLength(0)
    expect(recovery).toHaveBeenCalledOnce()
    setEditorMutationLocked(a, false)
    insert(b, 'allowed')
    expect(events).toHaveLength(1)
  })

  it('projects remote content without capturing it again or resetting pane navigation', () => {
    const { coordinator, a, b, insert, events } = setup()
    setZoom(b, 'beta')
    const node = findBullet(coordinator.editor.state.doc, 'alpha')!
    coordinator.editor.view.dispatch(coordinator.editor.state.tr.insertText('remote', node.pos + 2)
      .setMeta('forageRemote', true).setMeta('preventUpdate', true).setMeta('addToHistory', false))
    expect(events).toHaveLength(0)
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
    expect(getOutlinerUiState(b).zoomId).toBe('beta')
    insert(a, 'local')
    expect(events).toHaveLength(1)
  })

  it('captures atomic deletion and restoration once while updating all views', () => {
    const { a, b, events } = setup()
    const entry = trashBullet(a, 'alpha')!
    expect(findBullet(b.state.doc, 'alpha')).toBeNull()
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('trash.entry_added')
    restoreBullet(b, entry)
    expect(findBullet(a.state.doc, 'alpha')).not.toBeNull()
    expect(events).toHaveLength(2)
    expect(events[1].type).toBe('trash.entry_restored')
  })

  it('uses shared durable undo/redo across pane switches and reconstructs restart state', async () => {
    const { coordinator, a, b, insert, events, history } = setup()
    const before = createInitialOutlineState(coordinator.editor.getJSON())
    insert(a, 'A')
    insert(a, 'a')
    insert(b, 'B')
    expect(history.undo).toHaveLength(2)
    expect(history.undo[0].events).toHaveLength(2)
    expect(dispatchPersistentUndo(documentEditor(a), history)).not.toBeNull()
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
    expect(events.filter(e => e.type === 'document.undo_applied')).toHaveLength(1)
    expect(dispatchPersistentRedo(documentEditor(b), history)).not.toBeNull()
    expect(events.filter(e => e.type === 'document.redo_applied')).toHaveLength(1)
    const durable = await Promise.all(events.map(finalizeDocumentEvent))
    const replayed = durable.reduce(reduceOutlineEvent, before)
    expect(replayed.doc).toEqual(coordinator.editor.getJSON())
    expect(rebuildPersistentHistory(durable, 'device').undo).toHaveLength(2)
  })

  it('keeps stable-target programmatic work alive after the initiating pane closes', async () => {
    const { coordinator, a, b, events } = setup()
    const mutationEditor = documentEditor(a)
    const target = 'alpha'
    a.destroy()
    await Promise.resolve()
    const output = insertAiChildUnder(mutationEditor, target)!
    writeAiText(mutationEditor, output, 'Completed after close', '')
    expect(coordinator.editor.isDestroyed).toBe(false)
    expect(documentEditor(a)).toBe(mutationEditor)
    expect(b.state.doc.textContent).toContain('Completed after close')
    expect(events).toHaveLength(2)
  })
})
