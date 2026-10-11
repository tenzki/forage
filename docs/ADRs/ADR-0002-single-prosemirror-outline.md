# ADR-0002: Represent the Outline as One ProseMirror Document

- **Status:** Accepted
- **Date:** 2026-08-14
- **Amended:** 2026-09-30
- **Deciders:** AI Chat project team
- **Supersedes:** None (replaces an undocumented per-node-editor model)
- **Superseded by:** None

## Context

The outline must support arbitrary nesting, keyboard restructuring, drag reordering, rich text, and coherent undo/redo. The earlier implementation split bullets across individual editors and mirrored structural state through Zustand and a Rust/SQLite undo system. A single user action could cross several histories and persistence boundaries, producing unreliable undo behavior.

ProseMirror already models nested documents and transaction mappings. TipTap exposes that model to React. Forage's event store now also requires undo and redo to survive persistence and synchronization, so the editor's ephemeral native history cannot be the user-facing authority.

## Decision Drivers

- Correct, atomic undo and redo for text and structural edits.
- One authoritative in-memory representation of the outline.
- Native representation of nested bullets.
- Reliable selection mapping during moves and agent generation.
- Reduced synchronization between editor, application store, and persistence.

## Considered Options

1. **One TipTap/ProseMirror document** — all bullets are nested `listItem` nodes in one canonical document, presented through full-document views.
2. **One editor per bullet** — keep tree structure in an external store and mount an editor for each active row.
3. **Headless tree model plus editing adapter** — make a custom tree the source of truth and translate edits to and from ProseMirror.

## Decision

We will **represent the complete outline as one TipTap/ProseMirror document and use ProseMirror transactions plus durable compensating events for editing and undo** because **one document model keeps content, hierarchy, selection, and undo consistent across sessions and synchronized devices**.

The document is the source of truth for outline content and structure. Zustand may hold settings, but it must not become a second outline store. ProseMirror's native undo plugin is disabled; Mod-Z and redo dispatch inverse or forward steps recorded in the durable event log. The in-memory undo index is derived from those events and is cleared or rebuilt at migration, remote, and other unsafe mapping boundaries. The canonical document session survives Settings and pane closure. Full-document views may mount and unmount independently; their selection and transient UI belong to each pane. The production workspace retains its mounted outline views across Settings, Tasks, and Trash.

### Multiple full-document views (2026-09-30 amendment)

One canonical ProseMirror state/revision owns document commits. View transactions identify their pane and base revision. Document-changing normalization and stable-ID assignment run once at that boundary; one capture subscriber receives the root plus appended transactions for one durable event. Project committed steps into each full-document view without repeating admission/normalization, capture, agent invocation, or history. Independent TipTap editors saving their copies or broadcasting `setContent` are not a coordination strategy.

Map pane-local selections through every commit without stealing focus or scrolling inactive views. Rebase stale steps through retained mappings or return a recoverable conflict retaining typed input. Defer projections into a composing view, reconcile its buffered steps at composition completion, and retain input/DOM when safe mapping fails. A production adapter must coordinate with ProseMirror’s final composition DOM flush.

All views use the same durable compensating-event undo/redo authority. Switching panes ends the typing group. Persistence, synchronization, and stable-ID-targeted agent work belong to the canonical session, not a rendered pane; closing an initiating pane cannot cancel or retarget accepted work. Persisted collapse is shared; selection, zoom, navigation, filtering, menus, and scroll are view-local.

Production routing uses `src/editor/DocumentCoordinator.ts`, owned by `App`, with session-local pane order, location, history, and scroll managed by `src/workspace/WorkspaceController.ts`. Multiple full-document adapters share that authority without creating document events when opened, split, or navigated. Deleted targets remain unavailable until restored or explicitly navigated away from. The original feasibility fixtures remain under `src/editor/prototypes/`.

## Consequences

### Positive

- Text and structural changes share one durable undo history.
- Nesting is encoded directly in document structure.
- Search, zoom, collapse, and reordering can inspect one document.
- Persistence can serialize the editor document without model conversion.

### Negative

- Operations often require ProseMirror position and transaction knowledge.
- Traversing the entire document may become expensive for very large outlines.
- UI state implemented as decorations must stay compatible with document transactions.
- Selection and other ephemeral editor state are lost if the editor is recreated; durable undo can be rebuilt from stored local events.

### Risks and Mitigations

- **Risk:** Custom operations produce invalid document structure or stale positions.  
  **Mitigation:** Build changes through schema nodes and transactions, then test nested and reordered outlines.
- **Risk:** Full-document scans become slow as outlines grow.  
  **Mitigation:** Benchmark against the product target and add transaction-aware indexing only when measurements justify it.
- **Risk:** React rerenders accidentally recreate the editor.  
  **Mitigation:** Retain the canonical document session for the app lifetime; attach/detach full-document views without recreating document or history authority. Hide the workspace across application view changes while retaining its outline adapters.

## Option Analysis

### Option A: One TipTap/ProseMirror Document

**Advantages**

- Native transactions and selection mapping, with durable event-backed undo.
- Direct support for nested list structures and rich text.
- No synchronization layer between bullet editors.

**Disadvantages**

- Requires familiarity with ProseMirror node positions and plugins.
- Very large documents may require optimization.

### Option B: One Editor per Bullet

**Advantages**

- Individual row components appear locally simple.
- External tree operations can avoid ProseMirror internals.

**Disadvantages**

- Text, structure, focus, and undo span independent state machines.
- Cross-bullet edits and persistence are difficult to make atomic.

### Option C: Headless Tree Model plus Editing Adapter

**Advantages**

- Domain model is independent of a specific editor library.
- Non-editor consumers can use a purpose-built tree API.

**Disadvantages**

- Requires bidirectional synchronization and custom history semantics.
- Duplicates capabilities already supplied by ProseMirror.

## Implementation Notes

`src/editor/OutlinerEditor.tsx` mounts a production full-document view with native undo/redo and document append hooks disabled. Its dispatcher submits document mutations to the App-owned `DocumentCoordinator`; structural helpers may use the source view for local command context while commits, normalization, capture, and projections use the canonical authority. `src/App.tsx` retains one `OutlineSession`, capture callback, and derived durable undo index across view changes. Undo/redo, synchronization, accepted agent work, and asynchronous result placement use the canonical editor independently of rendered-view lifetime.

Do not reintroduce a per-node editor, an external outline source of truth, or a competing undo authority without superseding this ADR. A transient history index derived from the durable event log is part of this decision, not a second source of truth.

## Validation

- Undo and redo restore text edits, indentation, moves, deletes, and generated branches as coherent actions.
- Keyboard, drag, zoom, collapse, and search tests operate on nested documents.
- Opening and closing Settings preserves document state and undo history.
- Two full-document views normalize and capture one change once, preserve identities, map inactive selections, and project one compensating change.
- Stale and composing input is safely reconciled or retained for explicit recovery; projection cannot steal focus.
- Pane closure preserves canonical session and accepted asynchronous work.
- Performance remains acceptable on an outline containing at least 1,000 bullets.

## References

- `src/editor/OutlinerEditor.tsx`
- `src/editor/outlineModel.ts`
- `src/editor/outlinerUi.ts`
- `src/App.tsx`
- `.planning/debug/undo-still-broken.md`
