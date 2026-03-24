---
phase: 02-core-outliner
plan: 03
subsystem: ui
tags: [tiptap, react, zustand, react-arborist, drag-and-drop, keyboard-shortcuts, range-selection]

# Dependency graph
requires:
  - phase: 02-core-outliner-02-02
    provides: react-arborist Tree rendering, NodeRow plain text, treeStore with toggleNode/zoomIn/zoomOut, ipc layer with createNodeIpc/deleteNodeIpc/moveNodeIpc/updateNodeIpc

provides:
  - TipTap inline editor (NodeEditor.tsx) mounted only for focused node
  - OutlinerKeys TipTap extension with all 10 keyboard shortcuts (Enter, Tab, Shift-Tab, Backspace, Alt+Arrow x4, Shift+Arrow x2)
  - Range selection state (selectedNodeIds, anchorNodeId) with selectRange, clearSelection
  - Batch operations: batchIndent, batchOutdent, batchDelete for range-selected nodes
  - Store actions: createNode, deleteNode, updateContent (debounced 300ms), indentNode, outdentNode, reorderNode, moveNode
  - react-arborist drag-and-drop enabled via onMove callback using positionForMove
  - Range selection highlight CSS (.node-row-range-selected) and TipTap editor styles
  - Drag-and-drop CSS: drop line indicator, nesting highlight, grab cursor

affects: [03-ai-panel, 04-node-editor, any phase using treeStore mutations]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "OutlinerKeys TipTap Extension: all keyboard shortcuts declared in addKeyboardShortcuts(), options passed via configure() to avoid stale closures"
    - "One TipTap instance per tree: editingNodeId in store gates which node renders NodeEditor vs plain span"
    - "Debounced updateContent: 300ms debounce on IPC call, optimistic local update is immediate"
    - "Range selection by flat DFS walk: getFlatVisibleIds() respects collapsed state for Shift+Arrow extension"
    - "positionForMove excludes dragIds before computing fractional key — prevents self-interference during reorder"

key-files:
  created:
    - src/components/Outliner/NodeEditor.tsx
  modified:
    - src/store/treeStore.ts
    - src/components/Outliner/NodeRow.tsx
    - src/components/Outliner/OutlinerView.tsx
    - src/style.css

key-decisions:
  - "TipTap 3.x Extension.create() API used — same API as TipTap 2 for addKeyboardShortcuts"
  - "Extension options pattern via configure() used for keyboard handler callbacks to prevent stale closures"
  - "editingNodeId in zustand store (not local state) so NodeRow and OutlinerView share focus state"
  - "React refs (nodeRef, selectedIdsRef) used inside extension callbacks to read latest store state without re-creating editor"
  - "batchOutdent processes bottom-to-top to avoid parent conflicts during sequential outdents"
  - "react-arborist onMove reloads tree after DnD for consistency"

patterns-established:
  - "Performance: one TipTap instance at a time — NodeRow conditionally renders NodeEditor only when editingNodeId matches"
  - "Optimistic UI: updateContent updates local tree immediately, debounces IPC 300ms"
  - "Extension options for callbacks: avoids stale closures in TipTap keyboard handlers"

requirements-completed: [TREE-01, TREE-04, TREE-06]

# Metrics
duration: 4min
completed: 2026-03-24
---

# Phase 02 Plan 03: TipTap Editing + Keyboard Shortcuts + Drag-and-Drop Summary

**TipTap inline editor with Workflowy keyboard shortcuts (Enter/Tab/Shift-Tab/Backspace/Alt+Arrow/Shift+Arrow range selection) and react-arborist drag-and-drop with fractional position calculation**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-24T19:59:24Z
- **Completed:** 2026-03-24T20:03:03Z
- **Tasks:** 2 auto (+ 1 human-verify checkpoint)
- **Files modified:** 5

## Accomplishments
- TipTap NodeEditor with OutlinerKeys extension covering all 10 keyboard shortcuts including Shift+Arrow range selection
- Full range selection system: selectedNodeIds state, selectRange, clearSelection, batchIndent/Outdent/Delete
- Store mutation layer: createNode, deleteNode, updateContent (debounced), indentNode, outdentNode, reorderNode, moveNode
- react-arborist drag-and-drop enabled via onMove with fractional position calculation via positionForMove
- Performance: only one TipTap instance active at a time (editingNodeId gates which row gets NodeEditor)

## Task Commits

Each task was committed atomically:

1. **Task 1: TipTap NodeEditor with OutlinerKeys extension, range selection, and store actions** - `9d79ca0` (feat)
2. **Task 2: Enable drag-and-drop with react-arborist onMove** - `b71e11e` (feat)

## Files Created/Modified
- `src/components/Outliner/NodeEditor.tsx` - TipTap editor with OutlinerKeys extension and all keyboard shortcuts
- `src/store/treeStore.ts` - Added 12 new actions: createNode, deleteNode, updateContent, indentNode, outdentNode, reorderNode, moveNode, selectRange, clearSelection, batchIndent, batchOutdent, batchDelete; selectedNodeIds and editingNodeId state
- `src/components/Outliner/NodeRow.tsx` - Conditionally renders NodeEditor for editing node, plain span for others; range selection highlight
- `src/components/Outliner/OutlinerView.tsx` - Removed disableDrag/disableDrop, added onMove and onDelete handlers, click-to-create
- `src/style.css` - TipTap editor styles, range selection highlight, drag-and-drop CSS

## Decisions Made
- TipTap 3.x uses same Extension.create() API as v2 — no migration needed for keyboard extension pattern
- Extension options via configure() for keyboard callbacks avoids stale closure issues with React state
- editingNodeId in zustand store (not component local state) — allows NodeRow and OutlinerView to share focus
- batchOutdent processes bottom-to-top to prevent parent conflicts during sequential outdents
- react-arborist onMove reloads full tree after DnD for data consistency

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Complete outliner interaction model delivered: typing, all keyboard shortcuts, range selection, drag-and-drop
- Human verification checkpoint (Task 3) required: run `cargo tauri dev` and test all shortcuts and DnD
- After verification passes, Phase 02 core outliner is complete
- Phase 03 (AI panel) can begin once human verifies the outliner works correctly

---
*Phase: 02-core-outliner*
*Completed: 2026-03-24*
