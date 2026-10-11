import { EditorState, Plugin, type Transaction } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'

interface Pane {
  view: EditorView
  revision: number
  composition?: { base: EditorState; revision: number; transactions: Transaction[] }
}

export type DispatchResult = { accepted: true } | {
  accepted: false
  reason: string
  /** Retain this transaction (including typed text) for explicit recovery. */
  pending: Transaction
}

/** Feasibility prototype, deliberately not wired into OutlineSession yet.
 * Only this state runs document admission/appendTransaction; view
 * states omit those hooks. There is one capture subscriber and no native undo plugin.
 */
export class DocumentCoordinator {
  state: EditorState
  revision = 0
  private panes = new Map<string, Pane>()
  private mappings: Mapping[] = []

  constructor(state: EditorState, private capture: (
    root: Transaction, appended: readonly Transaction[],
  ) => void) {
    this.state = state
  }

  attach(id: string, view: EditorView): () => void {
    if (this.panes.has(id)) throw new Error(`Duplicate pane: ${id}`)
    if (!view.state.doc.eq(this.state.doc)) throw new Error('Pane must present the canonical document')
    // EditorState.apply also invokes appendTransaction. View adapters must
    // exclude document normalization/admission hooks even for projections.
    view.updateState(view.state.reconfigure({ plugins: view.state.plugins.map(plugin =>
      new Plugin({ ...plugin.spec, appendTransaction: undefined, filterTransaction: undefined }),
    ) }))
    this.panes.set(id, { view, revision: this.revision })
    return () => { this.panes.delete(id) }
  }

  beginComposition(id: string): void {
    const pane = this.pane(id)
    if (!pane.composition) pane.composition = {
      base: pane.view.state, revision: pane.revision, transactions: [],
    }
  }

  endComposition(id: string): DispatchResult {
    const pane = this.pane(id)
    const composition = pane.composition
    if (!composition) return { accepted: true }
    const pending = composition.base.tr
    for (const tr of composition.transactions) for (const step of tr.steps) pending.step(step)
    pending.setSelection(pane.view.state.selection.getBookmark().resolve(pending.doc))
    const result = this.commit(id, pending, composition.revision)
    if (result.accepted) {
      pane.composition = undefined
      pane.view.updateState(composition.base)
      this.project(pane, this.state.selection)
    }
    // On conflict the DOM/state and composition buffer stay intact. The caller
    // must offer explicit recovery; retry does not silently discard the input.
    return result
  }

  dispatch(id: string, transaction: Transaction, baseRevision = this.pane(id).revision): DispatchResult {
    const pane = this.pane(id)
    if (pane.composition) {
      if (!transaction.before.eq(pane.view.state.doc)) return {
        accepted: false, reason: 'Composition transaction has an obsolete base', pending: transaction,
      }
      pane.composition.transactions.push(transaction)
      pane.view.updateState(pane.view.state.apply(transaction))
      return { accepted: true }
    }
    const result = this.commit(id, transaction, baseRevision)
    if (!result.accepted) this.project(pane)
    return result
  }

  private commit(id: string, input: Transaction, baseRevision: number): DispatchResult {
    const reject = (reason: string): DispatchResult => ({ accepted: false, reason, pending: input })
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || baseRevision > this.revision) return reject('Unknown revision')
    const source = this.pane(id)
    let root = this.state.tr
    let inputToCanonical = new Mapping()
    if (baseRevision === this.revision) {
      if (!input.before.eq(this.state.doc)) return reject('Document does not match the tagged revision')
      for (const step of input.steps) {
        if (root.maybeStep(step).failed) return reject('Step could not be applied')
      }
    } else {
      // Undo the local steps, map through canonical changes, then redo the
      // mapped local steps. Mirror pairs preserve positions inside local text.
      const expected = this.mappings[baseRevision]
      if (!expected || !input.before.eq(this.documents[baseRevision])) return reject('Obsolete or mismatched revision')
      for (let i = input.steps.length - 1; i >= 0; i--) inputToCanonical.appendMap(input.steps[i].getMap().invert())
      for (const mapping of this.mappings.slice(baseRevision)) inputToCanonical.appendMapping(mapping)
      let mapFrom = input.steps.length
      for (const step of input.steps) {
        const mapped = step.map(inputToCanonical.slice(mapFrom))
        mapFrom--
        if (!mapped || root.maybeStep(mapped).failed) return reject('Concurrent edit conflicts; input retained')
        inputToCanonical.appendMap(mapped.getMap(), mapFrom)
      }
    }
    root.setSelection(input.selection.map(root.doc, inputToCanonical))
    if (input.storedMarksSet) root.setStoredMarks(input.storedMarks)
    // Preserve event/compensation metadata without forwarding scroll requests.
    for (const key of ['forageCompensation', 'forageDomainMutation', 'forageRemote',
      'addToHistory', 'preventUpdate', 'composition', 'uiEvent', 'paste']) {
      const value: unknown = input.getMeta(key)
      if (value !== undefined) root.setMeta(key, value)
    }
    const before = this.state.doc
    const applied = this.state.applyTransaction(root)
    if (!applied.transactions.length) return reject('Canonical plugin rejected transaction')
    this.state = applied.state
    const mapping = new Mapping()
    for (const tr of applied.transactions) mapping.appendMapping(tr.mapping)
    if (applied.transactions.some(tr => tr.docChanged)) {
      this.documents[this.revision] = before
      this.batches.push(applied.transactions.flatMap(tr => tr.steps))
      this.mappings.push(mapping)
      this.revision++
      this.capture(applied.transactions[0], applied.transactions.slice(1))
    }
    for (const pane of this.panes.values()) {
      if (pane.composition) continue
      this.project(pane, pane === source ? this.state.selection : undefined)
    }
    return { accepted: true }
  }

  private documents: EditorState['doc'][] = []

  private project(pane: Pane, selection?: EditorState['selection']): void {
    const tr = pane.view.state.tr
    for (let revision = pane.revision; revision < this.revision; revision++) {
      for (const step of this.batches[revision] ?? []) tr.step(step)
    }
    if (selection) tr.setSelection(selection.getBookmark().resolve(tr.doc))
    tr.setMeta('addToHistory', false).setMeta('forageProjection', true)
    pane.view.updateState(pane.view.state.apply(tr))
    pane.revision = this.revision
  }

  private batches: Transaction['steps'][] = []

  private pane(id: string): Pane {
    const pane = this.panes.get(id)
    if (!pane) throw new Error(`Unknown pane: ${id}`)
    return pane
  }
}
