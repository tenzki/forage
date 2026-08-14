# ADR-0003: Embed Stable Bullet Identity in the Document

- **Status:** Accepted
- **Date:** 2026-08-14
- **Deciders:** AI Chat project team
- **Supersedes:** None
- **Superseded by:** None

## Context

ProseMirror positions change whenever content before a node changes, so they cannot serve as durable bullet identifiers. Agent streaming, zoom, collapse, reordering, and future references need to locate a logical bullet after transactions and reloads. Identity also must not be maintained in a second store that can drift from the document.

Each bullet additionally needs persisted metadata identifying user versus AI content and whether its descendants are collapsed.

## Decision Drivers

- Stable references across edits, moves, reloads, and agent stream updates.
- No second source of truth for bullet metadata.
- Duplicate-ID repair for pasted or cloned document content.
- Identity assignment that participates correctly in editor history.
- Simple serialized persistence with the ProseMirror document.

## Considered Options

1. **Attributes on `listItem` nodes** — persist UUID identity and metadata inside the document.
2. **ProseMirror positions** — identify bullets by their current numeric positions.
3. **External metadata map** — keep IDs and presentation metadata in Zustand or a database.
4. **Content-derived IDs** — hash bullet text and ancestry.

## Decision

We will **store `nodeId`, `nodeType`, and `collapsed` as attributes on every `listItem`, with a ProseMirror plugin assigning unique UUIDs** because **identity and metadata must travel atomically with the document nodes they describe**.

The plugin will scan the resulting document in `appendTransaction` and assign a new UUID to any list item with a missing or duplicate ID. This places ID repair in the same history step as the edit that introduced the node.

## Consequences

### Positive

- Moving a bullet preserves its identity and metadata.
- Agent and UI operations can relocate nodes after document changes.
- Serialized documents are self-contained.
- Pasted or malformed duplicate IDs are repaired automatically.
- AI-authored bullets can be styled from `nodeType` without an external lookup.

### Negative

- Every transaction currently performs a document scan for missing and duplicate IDs.
- External importers must tolerate project-specific attributes.
- Code must use IDs for durable references and positions only for immediate transactions.
- Attribute schema changes require persistence compatibility consideration.

### Risks and Mitigations

- **Risk:** Duplicate IDs cause operations to target the wrong bullet.  
  **Mitigation:** Track IDs seen during `appendTransaction` and replace later duplicates.
- **Risk:** Identity-repair scans become a bottleneck.  
  **Mitigation:** Measure large documents and optimize using changed ranges only if profiling demonstrates a problem.
- **Risk:** A newly added list item temporarily has no ID.  
  **Mitigation:** Treat plugin-normalized editor state as authoritative and provide explicit IDs for programmatic agent inserts.

## Option Analysis

### Option A: Attributes on `listItem` Nodes

**Advantages**

- Identity is persisted and moves with the node.
- No cross-store synchronization is needed.
- Metadata is available to ProseMirror rendering and transactions.

**Disadvantages**

- Adds application-specific schema attributes.
- Requires normalization when content is inserted or pasted.

### Option B: ProseMirror Positions

**Advantages**

- Requires no additional schema data.
- Convenient within a single transaction.

**Disadvantages**

- Positions are invalidated by ordinary edits.
- They cannot survive reloads or support durable references.

### Option C: External Metadata Map

**Advantages**

- Keeps the editor document more portable.
- Could support indexed lookup outside the editor.

**Disadvantages**

- Creates a second source of truth and atomicity problems.
- Move, copy, undo, and deletion require manual synchronization.

### Option D: Content-Derived IDs

**Advantages**

- No random ID needs to be stored.
- Identity can be recomputed.

**Disadvantages**

- Editing text or ancestry changes identity.
- Duplicate content creates collisions or unstable disambiguation.

## Implementation Notes

`BulletAttributes` in `src/editor/extensions.ts` defines and serializes the attributes. UUIDs come from `crypto.randomUUID()` through `newNodeId()`. Agent insertion supplies IDs eagerly, while the plugin remains the invariant-enforcement layer for all creation paths.

Code that holds a reference across transactions must retain `nodeId` and resolve its latest position from the current document.

## Validation

- Every list item has a non-empty, unique `nodeId` after transaction processing.
- IDs survive text changes, nesting, reordering, undo/redo, save, and reload.
- Pasting content with duplicate or absent IDs yields unique IDs.
- `nodeType: "ai"` and `collapsed` survive persistence round trips.

## References

- `src/editor/extensions.ts`
- `src/editor/outlineModel.ts`
- `src/agent/insertIntoEditor.ts`
- `src/types/tree.ts`
