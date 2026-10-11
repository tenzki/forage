import { CommandManager, Editor, type EditorOptions } from '@tiptap/core'
import { EditorState, Plugin, type Transaction } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import { outlineExtensions } from './outlineExtensions'
import { registerDocumentEditor } from './documentAccess'
import { getOutlinerUiState, isSharedActivityTransaction, SHARED_ACTIVITY_META } from './outlinerUi'
import { isStreamingTransaction, streamingDecorations, STREAMING_PROJECTION_META } from './agentStreamingText'
import type { JsonValue } from '../types/tree'
import { EMPTY_DOC, normalizeOutlinerDoc } from './emptyDoc'

export interface RecoveredInput {
  paneId: string
  reason: string
  pending: Transaction
}
interface Pane {
  editor: Editor
  dispatch: (transaction: Transaction) => void
  revision: number
  composition?: { state: EditorState; revision: number; transactions: Transaction[] }
}
interface Commit {
  revision: number
  before: EditorState['doc']
  steps: Transaction['steps']
  mapping: Mapping
}
interface CoordinatorOptions {
  onTransaction?: (root: Transaction, appended: readonly Transaction[]) => void
  onDocChange?: (doc: JsonValue) => void
  onRecovery?: (input: RecoveredInput) => void
  onPaneSwitch?: () => void
  retainedRevisions?: number
}

// ProseMirror exposes metadata access by key, but no enumeration method. Keep
// this pinned-PM bridge in one place so arbitrary domain/extension/plugin keys
// survive rebase and source projection rather than using a lossy allowlist.
function copyMetadata(source: Transaction, target: Transaction): void {
  const metadata = (source as unknown as { meta: Record<string, unknown> }).meta
  for (const key of Object.keys(metadata)) target.setMeta(key, source.getMeta(key))
}

/** TipTap adapters share the exact canonical schema before plugins/input rules
 * are created. Refresh command contexts too: TipTap builds them before its
 * onBeforeCreate hook. Each adapter still owns its editor-bound UI closures.
 */
class OutlineViewEditor extends Editor {
  private localCommands?: CommandManager
  private get paneCommands(): CommandManager {
    return this.localCommands ??= new CommandManager({ editor: this })
  }
  override get commands() { return this.paneCommands.commands }
  override chain() { return this.paneCommands.chain() }
  override can() { return this.paneCommands.can() }
}

/** One full-document authority and one capture path, owned by App/OutlineSession.
 * The detached canonical editor is a command adapter, never a rendered pane.
 * Closing a view cannot dispose it, persistence, history, or admitted agent work.
 */
export class DocumentCoordinator {
  readonly editor: Editor
  revision = 0
  readonly recovery = new Map<string, RecoveredInput>()
  private panes = new Map<string, Pane>()
  private commits: Commit[] = []
  private source: { id: string; input: Transaction } | null = null
  private activePane: string | null = null
  private nativeDispatch: (transaction: Transaction) => void
  private applied = false
  private disposed = false

  constructor(content: JsonValue | null, private options: CoordinatorOptions = {}) {
    this.editor = new Editor({ extensions: outlineExtensions(true),
      content: normalizeOutlinerDoc(content ?? EMPTY_DOC) as object })
    registerDocumentEditor(this.editor, this.editor)
    this.nativeDispatch = this.editor.view.props.dispatchTransaction!
    this.editor.on('transaction', ({ transaction, appendedTransactions }) => {
      this.applied = true
      const changed = [transaction, ...appendedTransactions].some(tr => tr.docChanged)
      if (changed) {
        const mapping = new Mapping()
        for (const tr of [transaction, ...appendedTransactions]) mapping.appendMapping(tr.mapping)
        this.commits.push({ revision: this.revision, before: transaction.before,
          steps: [transaction, ...appendedTransactions].flatMap(tr => tr.steps), mapping })
        this.revision++
        if (this.commits.length > (this.options.retainedRevisions ?? 256)) this.commits.shift()
      }
      if (changed || isSharedActivityTransaction(transaction) || isStreamingTransaction(transaction)) {
        for (const [id, pane] of this.panes) {
          if (!pane.composition) this.project(pane, this.source?.id === id ? transaction : undefined)
        }
      }
      if (changed) {
        this.options.onTransaction?.(transaction, appendedTransactions)
        this.options.onDocChange?.(this.editor.getJSON() as JsonValue)
      }
    })
    this.editor.view.setProps({ dispatchTransaction: transaction => {
      if (!this.commit(transaction, this.revision)) throw new Error('The canonical outline rejected this mutation.')
    } })
  }

  createView(id: string, options: Partial<EditorOptions> = {}): Editor {
    if (this.disposed) throw new Error('The outline is closed.')
    const supplied = options.onBeforeCreate
    const editor = new OutlineViewEditor({ ...options, extensions: outlineExtensions(),
      content: this.editor.getJSON(),
      editorProps: {
        ...options.editorProps,
        handleDOMEvents: {
          ...options.editorProps?.handleDOMEvents,
          paste: (view, event) => {
            // Paste rules retain clipboard provenance in plugin closures. The
            // detached authority must see it too, so copying marked content
            // between views does not apply external-paste rules a second time.
            for (const plugin of this.editor.state.plugins) {
              if (plugin.spec.appendTransaction) plugin.props.handleDOMEvents?.paste?.call(plugin, this.editor.view, event)
            }
            return options.editorProps?.handleDOMEvents?.paste?.(view, event) ?? false
          },
        },
      },
      onBeforeCreate: event => {
        event.editor.schema = this.editor.schema
        event.editor.extensionManager.schema = this.editor.schema
        supplied?.(event)
      },
    })
    // Core paste/autolink/clear-document rules are document-changing append
    // hooks too. Retain pane-bound props/state, but run those hooks only in the
    // canonical editor. Pane UI extensions have no appendTransaction hooks.
    editor.view.updateState(editor.state.reconfigure({ plugins: editor.state.plugins.map(plugin =>
      plugin.spec.appendTransaction ? new Plugin({ ...plugin.spec, appendTransaction: undefined }) : plugin,
    ) }))
    this.attach(id, editor)
    return editor
  }

  attach(id: string, editor: Editor): () => void {
    if (this.panes.has(id)) throw new Error(`Duplicate pane: ${id}`)
    if (editor.schema !== this.editor.schema || !editor.state.doc.eq(this.editor.state.doc)) {
      throw new Error('A pane must use the full canonical document and schema.')
    }
    if (editor.state.plugins.some(plugin => plugin.spec.appendTransaction)) {
      throw new Error(`Document normalization plugins cannot run in a pane: ${editor.state.plugins.filter(plugin => plugin.spec.appendTransaction).map(plugin => (plugin as unknown as { key: string }).key).join(', ')}`)
    }
    const pane: Pane = { editor, dispatch: editor.view.props.dispatchTransaction!, revision: this.revision }
    registerDocumentEditor(editor, this.editor, id)
    editor.view.dom.dataset.paneId = id
    this.panes.set(id, pane)
    editor.view.setProps({ dispatchTransaction: transaction => this.dispatch(id, transaction) })
    const detach = () => {
      if (this.panes.get(id) !== pane) return
      if (pane.composition && !this.disposed) this.endComposition(id)
      this.panes.delete(id)
      if (this.activePane === id) { this.activePane = null; this.options.onPaneSwitch?.() }
      if (!editor.isDestroyed) editor.view.setProps({ dispatchTransaction: pane.dispatch })
    }
    editor.on('destroy', detach)
    this.project(pane)
    return detach
  }

  activate(id: string): void {
    if (!this.panes.has(id)) throw new Error(`Unknown pane: ${id}`)
    if (this.activePane === id) return
    this.activePane = id
    this.options.onPaneSwitch?.()
  }

  deactivate(): void {
    if (this.activePane === null) return
    this.activePane = null
    this.options.onPaneSwitch?.()
  }

  beginComposition(id: string): void {
    const pane = this.pane(id)
    this.activate(id)
    pane.composition ??= { state: pane.editor.state, revision: pane.revision, transactions: [] }
  }

  endComposition(id: string): boolean {
    const pane = this.pane(id)
    const composition = pane.composition
    if (!composition) return true
    const pending = composition.state.tr
    for (const transaction of composition.transactions) {
      for (const step of transaction.steps) pending.step(step)
      copyMetadata(transaction, pending)
    }
    pending.setSelection(pane.editor.state.selection.getBookmark().resolve(pending.doc))
    if (!this.commit(pending, composition.revision, id)) return this.reject(id, pending, 'Composition conflicts with another change; input retained.')
    pane.composition = undefined
    pane.editor.view.updateState(composition.state)
    this.project(pane, pending)
    return true
  }

  dispatch(id: string, input: Transaction, revision = this.pane(id).revision): boolean {
    const pane = this.pane(id)
    if (input.getMeta('focus')) this.activate(id)
    if (pane.composition) {
      if (!input.before.eq(pane.editor.state.doc)) return this.reject(id, input, 'Obsolete composing transaction; input retained.')
      pane.composition.transactions.push(input)
      pane.dispatch(input)
      return true
    }
    if (!input.docChanged && !isSharedActivityTransaction(input) && !isStreamingTransaction(input)) {
      pane.dispatch(input)
      return true
    }
    if (input.docChanged) this.activate(id)
    if (!this.commit(input, revision, id)) {
      this.project(pane)
      return this.reject(id, input, 'Concurrent or rejected change; input retained for recovery.')
    }
    return true
  }

  private commit(input: Transaction, base: number, id?: string): boolean {
    if (this.disposed || !Number.isSafeInteger(base) || base < 0 || base > this.revision) return false
    let root = input
    if (base !== this.revision) {
      const intervening = this.commits.filter(commit => commit.revision >= base)
      if (intervening[0]?.revision !== base || !input.before.eq(intervening[0].before)) return false
      const mapping = new Mapping()
      for (let i = input.steps.length - 1; i >= 0; i--) mapping.appendMap(input.steps[i].getMap().invert())
      for (const commit of intervening) mapping.appendMapping(commit.mapping)
      root = this.editor.state.tr
      let mapFrom = input.steps.length
      for (const step of input.steps) {
        const mapped = step.map(mapping.slice(mapFrom--))
        if (!mapped || root.maybeStep(mapped).failed) return false
        mapping.appendMap(mapped.getMap(), mapFrom)
      }
      root.setSelection(input.selection.map(root.doc, mapping))
      copyMetadata(input, root)
      if (input.storedMarksSet) root.setStoredMarks(input.storedMarks)
    } else if (!input.before.eq(this.editor.state.doc)) return false
    if (id) root.setMeta('foragePaneId', id)
    this.applied = false
    const previousSource = this.source
    this.source = id ? { id, input } : null
    try { this.nativeDispatch(root) } finally { this.source = previousSource }
    return this.applied
  }

  private project(pane: Pane, source?: Transaction): void {
    const transaction = pane.editor.state.tr
    for (const commit of this.commits) {
      if (commit.revision >= pane.revision) for (const step of commit.steps) transaction.step(step)
    }
    if (!transaction.doc.eq(this.editor.state.doc)) throw new Error('A pane projection missed canonical changes.')
    if (source) {
      transaction.setSelection(this.editor.state.selection.getBookmark().resolve(transaction.doc))
      if (source.storedMarksSet) transaction.setStoredMarks(source.storedMarks)
      copyMetadata(source, transaction)
      if (source.scrolledIntoView) transaction.scrollIntoView()
    }
    transaction.setMeta(SHARED_ACTIVITY_META, getOutlinerUiState(this.editor).agentActivity)
      .setMeta(STREAMING_PROJECTION_META, streamingDecorations(this.editor))
      .setMeta('forageProjection', true).setMeta('addToHistory', false)
    // Use the adapter's native dispatcher for TipTap UI notifications, never
    // the coordinator dispatch path or a persistence subscriber.
    pane.revision = this.revision
    pane.dispatch(transaction)
  }

  private reject(id: string, pending: Transaction, reason: string): false {
    const recovery = { paneId: id, pending, reason }
    this.recovery.set(id, recovery)
    this.options.onRecovery?.(recovery)
    return false
  }

  private pane(id: string): Pane {
    const pane = this.panes.get(id)
    if (!pane) throw new Error(`Unknown pane: ${id}`)
    return pane
  }

  destroy(): void {
    this.disposed = true
    for (const pane of [...this.panes.values()]) pane.editor.destroy()
    this.panes.clear()
    this.editor.destroy()
    this.commits = []
    this.recovery.clear()
  }
}
