# ADR-0002: Represent the Outline as One ProseMirror Document

- **Status:** Accepted
- **Date:** 2026-08-14
- **Deciders:** AI Chat project team
- **Supersedes:** None (replaces an undocumented per-node-editor model)
- **Superseded by:** None

## Context

The outline must support arbitrary nesting, keyboard restructuring, drag reordering, rich text, and coherent undo/redo. The earlier implementation split bullets across individual editors and mirrored structural state through Zustand and a Rust/SQLite undo system. A single user action could cross several histories and persistence boundaries, producing unreliable undo behavior.

ProseMirror already models nested documents and supplies transaction-based history. TipTap exposes that model to React.

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

We will **represent the complete outline as one TipTap/ProseMirror document and use ProseMirror transactions and native history for editing** because **one transactional model keeps content, hierarchy, selection, and undo consistent**.

The document is the source of truth for outline content and structure. Zustand may hold settings, but it must not become a second outline store. The editor remains mounted while the settings view is shown so its live document and history are preserved.

## Consequences

### Positive

- Text and structural changes share one undo history.
- Nesting is encoded directly in document structure.
- Search, zoom, collapse, and reordering can inspect one document.
- Persistence can serialize the editor document without model conversion.

### Negative

- Operations often require ProseMirror position and transaction knowledge.
- Traversing the entire document may become expensive for very large outlines.
- UI state implemented as decorations must stay compatible with document transactions.
- Unmounting or recreating the editor discards in-memory history.

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

- Native transactional history and selection mapping.
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

`src/editor/OutlinerEditor.tsx` mounts one editor with StarterKit and project extensions. Structural helpers in `src/editor/outlineModel.ts` must dispatch transactions against that editor. `src/App.tsx` keeps the editor mounted across view changes and serializes `editor.getJSON()` on updates.

Do not reintroduce a per-node editor, an external outline source of truth, or a separate undo stack without superseding this ADR.

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
