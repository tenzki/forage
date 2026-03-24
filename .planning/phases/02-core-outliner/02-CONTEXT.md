# Phase 2: Core Outliner - Context

**Gathered:** 2026-03-24
**Status:** Ready for planning

<domain>
## Phase Boundary

React frontend rendering an infinite nested tree with Workflowy-style UX. Users can create, edit, navigate, zoom into, and rearrange nodes entirely via keyboard or mouse drag. Delivers TREE-01 (infinite nesting), TREE-02 (expand/collapse), TREE-03 (zoom/hoist), TREE-04 (keyboard navigation), TREE-06 (drag to reorder). No search, undo, or Markdown rendering in this phase.

</domain>

<decisions>
## Implementation Decisions

### Visual Feel
- Workflowy-minimal aesthetic — white background, tiny chrome, content is everything
- Light theme only for v1 (no dark mode)
- System font (San Francisco on macOS) — native feel, no web font loading
- Small filled circle bullets (Workflowy-style) — dot toggles expand/collapse
- Minimal spacing, high content density

### Keyboard Behavior
- Exact Workflowy keyboard bindings:
  - Enter = new sibling below (regardless of whether current node has children)
  - Tab = indent (nest under previous sibling)
  - Shift+Tab = outdent (move to parent's level)
  - Alt+Up/Down = reorder among siblings
  - Alt+Left = outdent (same as Shift+Tab via keyboard move)
  - Alt+Right = nest under previous sibling (same as Tab via keyboard move)
  - Delete/Backspace on empty node = delete node, cursor moves to previous node's end
- Shift+Arrow selects range of nodes for batch move/indent/delete
- Alt+Arrow provides full move capability (reorder + re-nest across parents)

### Zoom/Hoist UX
- Click bullet to zoom into node (node becomes root view)
- Clickable breadcrumb trail at top: Home > Parent > Current — each segment navigates back
- Subtle 150ms crossfade transition on zoom
- Window title reflects current zoomed node text

### Drag-and-Drop
- Full drag capability: reorder siblings, re-nest under new parent, move across depth levels
- Drop indicator: line between nodes for reorder, highlight on target for nesting (context-dependent)
- Entire subtree moves together when dragging a node with children
- Mouse drag and keyboard (Alt+Arrow) provide equivalent move capabilities

### Claude's Discretion
- React tree component choice (react-arborist vs custom)
- CSS approach (Tailwind, CSS modules, etc.)
- State management pattern (React context, Zustand, etc.)
- Virtualization strategy for large trees
- Exact animation easing and timing
- Empty state design (first launch)

</decisions>

<specifics>
## Specific Ideas

- "Workflowy-style" is the reference for all UX decisions — when in doubt, match Workflowy
- The outliner must feel fast and keyboard-native — no lag on key repeat, no janky animations
- Rich text (TipTap/ProseMirror JSON) is the content format from Phase 1 — but inline Markdown rendering is Phase 3 (EDIT-02), this phase just needs basic text editing in nodes

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src-tauri/src/commands/nodes.rs`: 5 IPC commands (create_node, get_node, update_node, delete_node, get_children) — ready to consume from React
- `fractional-indexing` npm package already installed — use for position calculations on frontend
- `src/lib/` directory exists for tauri-specta bindings (generated on `cargo tauri dev`)

### Established Patterns
- Tauri IPC via tauri-specta: typed commands with `#[specta::specta]` annotation
- Node model: UUID id, parent_id (nullable), content (JSON), position (fractional string), node_type, collapsed (boolean), metadata (JSON)
- AppState with SqlitePool shared across commands

### Integration Points
- Frontend calls IPC commands via generated `bindings.ts` (tauri-specta output)
- `get_children(parent_id)` returns children ordered by fractional position — primary data fetch pattern
- `update_node` supports partial updates (only provided fields change)
- Collapsed state stored in DB — persists across app restarts

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-core-outliner*
*Context gathered: 2026-03-24*
