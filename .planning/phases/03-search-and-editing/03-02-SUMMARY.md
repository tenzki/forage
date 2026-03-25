---
phase: 03-search-and-editing
plan: 02
subsystem: database
tags: [rust, sqlx, tauri, zustand, tiptap, undo-redo, sqlite]

# Dependency graph
requires:
  - phase: 03-search-and-editing/03-01
    provides: undo_history and undo_pointer tables from 0002_search_and_editing.sql migration
provides:
  - Persistent undo/redo for all tree mutations (create, delete, indent, outdent, move, text_edit)
  - record_undo_step, undo_step, redo_step Rust IPC commands
  - UndoGroupTracker utility for 1-second text edit grouping
  - Cmd+Z / Cmd+Shift+Z keyboard shortcuts (TipTap extension + global window handler)
affects:
  - future phases using node mutations (undo recording wraps all structural operations)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - cascade-safe undo: read undo_history entries before node deletion; re-insert with FK checks disabled after cascade
    - text edit grouping: module-level UndoGroupTracker with 1s gap detection, flush on node switch or structural op
    - global keyboard capture: App.tsx window listener with capture:true intercepts before TipTap stopPropagation

key-files:
  created:
    - src-tauri/src/commands/undo.rs
    - src/utils/undoGrouping.ts
    - src/utils/undoGrouping.test.ts
  modified:
    - src-tauri/src/commands/mod.rs
    - src-tauri/src/lib.rs
    - src-tauri/tests/db_tests.rs
    - src/store/ipc.ts
    - src/store/treeStore.ts
    - src/components/Outliner/NodeEditor.tsx
    - src/App.tsx

key-decisions:
  - "ON DELETE CASCADE in undo_history requires cascade-safe pattern: read all entry data before deletion, re-insert after cascade with PRAGMA foreign_keys=OFF; avoids schema change"
  - "UndoGroupTracker at module level (not React state) to avoid re-renders on every keystroke"
  - "Global window Cmd+Z handler in App.tsx with capture:true ensures undo works even when no TipTap editor is focused"
  - "After undo/redo, call loadTree() to refresh entire visible tree from DB state — Rust backend is authoritative"

patterns-established:
  - "Cascade-safe undo: always read undo_history before deleting node; re-insert with FK disabled to preserve redo stack"
  - "Undo recording: fire-and-forget with .catch(console.warn) — never block the UI mutation for undo recording"
  - "Text edit grouping: shouldStartNewGroup returns true on >1000ms gap OR nodeId change, flush previous group on new group start"

requirements-completed: [EDIT-01]

# Metrics
duration: 6min
completed: 2026-03-25
---

# Phase 3 Plan 02: Undo/Redo Summary

**Persistent Cmd+Z/Cmd+Shift+Z undo/redo with SQLite undo_history, cascade-safe Rust IPC commands, and 1-second text edit grouping via UndoGroupTracker**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-25T10:42:24Z
- **Completed:** 2026-03-25T10:48:26Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- Rust undo/redo IPC commands (record_undo_step, undo_step, redo_step) with cascade-safe ON DELETE CASCADE handling
- UndoGroupTracker utility class with 17 passing vitest tests for 1-second text edit grouping logic
- Full frontend wiring: createNode, deleteNode, indentNode, outdentNode, reorderNode all record before/after snapshots
- Cmd+Z / Cmd+Shift+Z via TipTap OutlinerKeys extension AND global window capture handler in App.tsx
- Undo history survives app restart (persisted in undo_history table via SQLite)

## Task Commits

Each task was committed atomically:

1. **Task 1: Rust undo/redo IPC commands** - `9f1f732` (feat)
2. **Task 2: Frontend undo/redo wiring in Zustand store** - `69dce44` (feat)

## Files Created/Modified

- `src-tauri/src/commands/undo.rs` - record_undo_step, undo_step, redo_step with cascade-safe pattern
- `src-tauri/src/commands/mod.rs` - Added `pub mod undo;`
- `src-tauri/src/lib.rs` - Registered three undo commands in collect_commands![]
- `src-tauri/tests/db_tests.rs` - test_undo_redo_structural, test_undo_redo_text_group integration tests
- `src/store/ipc.ts` - recordUndoStepIpc, undoStepIpc, redoStepIpc wrappers
- `src/store/treeStore.ts` - undo/redo actions, UndoGroupTracker integration, structural op wrapping
- `src/utils/undoGrouping.ts` - UndoGroupTracker class (shouldStartNewGroup, startGroup, flush, touch, reset)
- `src/utils/undoGrouping.test.ts` - 17 pure vitest tests for grouping logic
- `src/components/Outliner/NodeEditor.tsx` - Mod-z / Mod-Shift-z in OutlinerKeys extension
- `src/App.tsx` - Global window-level Cmd+Z / Cmd+Shift+Z with capture:true

## Decisions Made

- **ON DELETE CASCADE workaround:** undo_history references nodes with FK ON DELETE CASCADE. When undoing a "create" (deleting the node), the undo_history entry also gets cascade-deleted, breaking redo. Fix: read all entry data before deletion, then re-insert the undo_history row with PRAGMA foreign_keys=OFF after the node is gone. This preserves the redo stack without schema changes.

- **Module-level UndoGroupTracker:** Placed at module level in treeStore.ts rather than in React state to avoid triggering re-renders on every keystroke.

- **Fire-and-forget undo recording:** recordUndoStepIpc calls are always fire-and-forget with `.catch(console.warn)` — undo recording failures never block the primary UI mutation.

- **loadTree() after undo/redo:** After undo or redo, call loadTree() to reload the entire visible tree from DB. The Rust backend is authoritative for state restoration.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ON DELETE CASCADE cascade-deletes undo_history entries, breaking redo after create/delete undo**

- **Found during:** Task 1 (Rust undo/redo IPC commands)
- **Issue:** undo_history.node_id REFERENCES nodes(id) ON DELETE CASCADE — deleting a node during "create" undo also deletes the undo_history entry, making redo impossible
- **Fix:** Read full row data (including after_json) before deletion; re-insert undo_history entry after cascade with PRAGMA foreign_keys=OFF; same pattern applied for "delete" redo operations
- **Files modified:** src-tauri/src/commands/undo.rs
- **Verification:** test_undo_redo_structural passes — node deleted by undo, re-created by redo
- **Committed in:** 9f1f732 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Critical fix for undo/redo correctness. Without it, redo after "create" undo would always return None.

## Issues Encountered

- SQLite FK constraint `REFERENCES nodes(id)` prevents re-inserting undo_history entries for deleted nodes. Solved by temporarily disabling FK checks per-operation with `PRAGMA foreign_keys = OFF/ON` around the specific INSERT statements.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Undo/redo fully operational for all structural operations and text edits
- History survives app restarts (persisted in SQLite undo_history table)
- Ready for Phase 3 remaining plans (node tagging, etc.)

---
*Phase: 03-search-and-editing*
*Completed: 2026-03-25*
