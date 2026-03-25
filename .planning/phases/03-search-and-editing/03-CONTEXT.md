# Phase 3: Search and Editing - Context

**Gathered:** 2026-03-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Global search across all nodes, persistent undo/redo for both text and structural operations, inline Markdown formatting (bold, italic, code), hashtag system with sidebar and autocomplete, and AI content visual distinction. Delivers TREE-05 (search), EDIT-01 (undo/redo), EDIT-02 (Markdown formatting), EDIT-03 (hashtags), EDIT-04 (AI content styling).

</domain>

<decisions>
## Implementation Decisions

### Search UX
- Cmd+K overlay panel (Spotlight/Linear style) — centered modal above the tree
- Full-text search using SQLite FTS5 on extracted text from TipTap JSON content
- Results show: node text with match highlighted, breadcrumb ancestor path (Home > Parent > Node), and text snippet around match
- Selecting a result zooms/hoists into that node (reuses existing zoom behavior), overlay closes
- Keyboard-navigable results (arrow keys to select, Enter to navigate)

### Undo/Redo
- Covers both text edits AND structural operations (indent, outdent, move, delete, create) — single unified Cmd+Z/Cmd+Shift+Z
- Global undo stack (not scoped to zoom level) — last action undone regardless of where it happened
- Full history persisted in the database — user can undo all the way back to the beginning, survives app restarts
- Text edits grouped by pause (~1s gap between keystrokes or node switch = new undo step)
- Structural operations are each a single undo step

### Markdown Formatting
- Bold, italic, and inline code supported via TipTap marks (StarterKit already includes these)
- No block-level Markdown (headings, blockquotes, code blocks, lists remain disabled) — consistent with Phase 2 decision
- Standard keyboard shortcuts: Cmd+B (bold), Cmd+I (italic), Cmd+E (code)

### Hashtags
- Typing #hashtag inline creates a visually highlighted tag with distinct color
- Hashtags are clickable — clicking opens search filtered to that tag
- Left sidebar (toggleable) shows all tags with counts
- Autocomplete dropdown appears after typing '#' + 2 characters, suggesting existing tags
- Tags indexed in database for fast lookup and sidebar population

### AI Content Styling
- Icon-only approach — small sparkle/AI icon replaces the bullet dot on agent_response nodes
- Icon shown on ALL nodes with node_type='agent_response', not just top-level of a branch
- Right-click context menu includes "Make mine" to convert AI node to regular user node (changes node_type to 'note', removes icon)
- Minimal and non-disruptive — fits Workflowy-minimal aesthetic from Phase 2

### Claude's Discretion
- FTS5 index structure and tokenizer choice
- Undo/redo database schema for persistent history
- Exact hashtag color and autocomplete dropdown styling
- Search overlay animation and keyboard shortcut details
- Tag sidebar layout and toggle shortcut
- Context menu implementation approach

</decisions>

<specifics>
## Specific Ideas

- Undo history is persistent in the database — this is a core requirement, not optional. The user explicitly wants undo all the way back to the start, surviving app restarts
- Search should feel like Spotlight/Linear — fast, keyboard-driven, ephemeral overlay
- Hashtag system has three parts: inline visual + click-to-filter + sidebar with counts — all three are required
- AI styling must be minimal (icon only, no borders or background tints) to preserve the Workflowy-clean aesthetic

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `NodeEditor.tsx`: TipTap editor with StarterKit — bold/italic/code marks already available, just need to ensure they're enabled and have toolbar/shortcut support
- `OutlinerKeys` extension: Custom TipTap extension for keyboard shortcuts — can be extended for Cmd+B/I/E
- `treeStore.ts`: Zustand store with all tree operations — undo/redo needs to wrap these operations
- `extractText()` utility in `types/tree.ts`: Extracts plain text from TipTap JSON — useful for FTS5 indexing
- `Bullet.tsx`: Renders bullet dots — needs modification to show AI icon for agent_response nodes

### Established Patterns
- TipTap v3 with StarterKit, single active editor (editingNodeId in Zustand)
- Content stored as ProseMirror JSON in SQLite via IPC
- Debounced content updates (300ms) to backend
- `node_type` column already distinguishes user vs agent nodes
- react-arborist for tree rendering with controlled mode

### Integration Points
- SQLite backend needs: FTS5 virtual table, undo history table, hashtag index table
- New IPC commands needed: search, undo/redo operations, tag queries
- Cmd+K overlay needs to sit above the react-arborist tree
- Tag sidebar needs to be a sibling component to OutlinerView
- Context menu (right-click) needs to be added to NodeRow

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-search-and-editing*
*Context gathered: 2026-03-25*
