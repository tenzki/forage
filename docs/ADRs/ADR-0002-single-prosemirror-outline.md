# ADR-0002: Represent the Outline as One ProseMirror Document

- **Status:** Accepted
- **Date:** 2026-08-14
- **Amended:** 2026-08-31
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

1. **One TipTap/ProseMirror document** — all bullets are nested `listItem` nodes in one editor.
2. **One editor per bullet** — keep tree structure in an external store and mount an editor for each active row.
3. **Headless tree model plus editing adapter** — make a custom tree the source of truth and translate edits to and from ProseMirror.

## Decision

We will **represent the complete outline as one TipTap/ProseMirror document and use ProseMirror transactions plus durable compensating events for editing and undo** because **one document model keeps content, hierarchy, selection, and undo consistent across sessions and synchronized devices**.

The document is the source of truth for outline content and structure. Zustand may hold settings, but it must not become a second outline store. ProseMirror's native undo plugin is disabled; Mod-Z and redo dispatch inverse or forward steps recorded in the durable event log. The in-memory undo index is derived from those events and is cleared or rebuilt at migration, remote, and other unsafe mapping boundaries. The editor remains mounted while the settings view is shown so its live document and selection are preserved.

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
  **Mitigation:** Mount one `OutlinerEditor` for the app lifetime and hide it rather than unmounting it.

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

`src/editor/OutlinerEditor.tsx` mounts one editor with StarterKit's native undo/redo disabled and project extensions. Structural helpers in `src/editor/outlineModel.ts` must dispatch transactions against that editor. `src/App.tsx` keeps the editor mounted across view changes, captures transactions as events, and maintains the derived durable undo index.

Do not reintroduce a per-node editor, an external outline source of truth, or a competing undo authority without superseding this ADR. A transient history index derived from the durable event log is part of this decision, not a second source of truth.

## Validation

- Undo and redo restore text edits, indentation, moves, deletes, and generated branches as coherent actions.
- Keyboard, drag, zoom, collapse, and search tests operate on nested documents.
- Opening and closing Settings preserves document state and undo history.
- Performance remains acceptable on an outline containing at least 1,000 bullets.

## References

- `src/editor/OutlinerEditor.tsx`
- `src/editor/outlineModel.ts`
- `src/editor/outlinerUi.ts`
- `src/App.tsx`
- `.planning/debug/undo-still-broken.md`
