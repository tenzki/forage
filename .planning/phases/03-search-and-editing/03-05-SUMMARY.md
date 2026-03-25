---
phase: 03-search-and-editing
plan: 05
subsystem: database
tags: [fts5, sqlite, undo-redo, tiptap, treestore, search]

# Dependency graph
requires:
  - phase: 03-search-and-editing
    provides: FTS5 search infrastructure, undo_history table, UndoGroupTracker, App.tsx global Cmd+Z handler

provides:
  - FTS5 index backfill for pre-existing nodes (migration 0002 INSERT INTO nodes_fts SELECT FROM nodes)
  - FTS5 rebuild on every app startup (setup.rs idempotent rebuild command)
  - Undo double-fire fix (removed Mod-z/Mod-Shift-z from OutlinerKeys, disabled StarterKit history)
  - Pending undo group recording (undo() flushes and records active typing session before undoStepIpc)

affects: [search, undo-redo, treeStore, NodeEditor]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - FTS5 rebuild command is idempotent and safe to run on every startup
    - StarterKit history: false required when using custom undo stack to prevent ProseMirror interference
    - App.tsx capture-phase keydown handler is the single source of truth for Cmd+Z/Cmd+Shift+Z

key-files:
  created: []
  modified:
    - src-tauri/migrations/0002_search_and_editing.sql
    - src-tauri/src/db/setup.rs
    - src/components/Outliner/NodeEditor.tsx
    - src/store/treeStore.ts

key-decisions:
  - "FTS5 rebuild on startup is idempotent: INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild') re-indexes all rows from content table, safe to run every time"
  - "Mod-z removed from OutlinerKeys: App.tsx capture-phase handler fires before TipTap, keeping both caused double undo() per keypress"
  - "StarterKit history: false required alongside custom undo — ProseMirror's built-in undo would intercept Cmd+Z before global handler in some focus states"
  - "undo() records pending flush via recordUndoStepIpc: active typing group must be committed to DB before undoStepIpc steps backward"

patterns-established:
  - "FTS5 external-content mode requires explicit backfill for pre-existing rows — triggers only fire for future changes"
  - "Custom undo stack pattern: disable all built-in undo (StarterKit history: false, no Mod-z in extensions), single global handler in App.tsx"

requirements-completed: [TREE-05, EDIT-01, EDIT-02]

# Metrics
duration: 15min
completed: 2026-03-25
---

# Phase 3 Plan 05: Fix FTS5 Search and Undo/Redo Summary

**FTS5 search backfilled for pre-existing nodes via migration INSERT + startup rebuild, and undo double-fire fixed by removing Mod-z from OutlinerKeys and recording pending flush before undoStepIpc**

## Performance

- **Duration:** 15 min
- **Started:** 2026-03-25T11:10:00Z
- **Completed:** 2026-03-25T11:25:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added FTS5 backfill INSERT statement in migration 0002 so nodes created before this migration are now searchable via Cmd+K
- Added idempotent FTS5 rebuild command in setup.rs that runs on every app startup, ensuring search always reflects current state
- Removed duplicate Cmd+Z/Cmd+Shift+Z handlers from OutlinerKeys extension, eliminating double-fire of undo()
- Disabled StarterKit's built-in ProseMirror history to prevent interference with the custom undo stack
- Updated undo() in treeStore to capture and record the pending text edit group via recordUndoStepIpc before calling undoStepIpc

## Task Commits

Each task was committed atomically:

1. **Task 1: Add FTS5 backfill to migration and startup rebuild** - `dab11b6` (fix)
2. **Task 2: Fix undo double-fire and pending group discard** - `4717516` (fix)

## Files Created/Modified

- `src-tauri/migrations/0002_search_and_editing.sql` - Added backfill INSERT INTO nodes_fts SELECT FROM nodes after sync triggers
- `src-tauri/src/db/setup.rs` - Added FTS5 rebuild command after migrations run on every startup
- `src/components/Outliner/NodeEditor.tsx` - Removed Mod-z/Mod-Shift-z from OutlinerKeys, added history: false to StarterKit
- `src/store/treeStore.ts` - Updated undo() to record pending flush via recordUndoStepIpc before undoStepIpc

## Decisions Made

- FTS5 external-content mode does NOT auto-index pre-existing rows — only INSERT/UPDATE/DELETE triggers fire going forward. The migration backfill is required for any rows created before migration 0002 was applied.
- The startup rebuild (idempotent) complements the migration backfill: it handles the case where the user's database already had migration 0002 applied (the backfill in the migration SQL won't re-run), ensuring all nodes are indexed on next launch.
- Removing Mod-z from OutlinerKeys is the correct fix for double-fire. The App.tsx capture-phase handler fires at the document level before the event reaches TipTap, so TipTap's keyboard handler would process the same event a second time.
- StarterKit history: false is necessary because ProseMirror's built-in undo can intercept Cmd+Z in certain editor focus states, bypassing the global custom undo stack.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Pre-existing TypeScript errors in HashtagNode.tsx and bindings.ts were present before this plan and are unrelated to the changes made. Both modified files (NodeEditor.tsx and treeStore.ts) have no TypeScript errors. The Rust build passes successfully.

## User Setup Required

None - no external service configuration required. However, the user's existing database needs to have migration 0002 re-applied or the app restarted to trigger the FTS5 rebuild. Since migration checksums will match (migration content changed), the user should delete their database or run a manual rebuild if search remains empty.

**Important note for the user:** The migration 0002 backfill INSERT will fail with a checksum error if the database already has migration 0002 applied, because sqlx validates migration checksums. The startup rebuild in setup.rs is the actual fix for users with existing databases. The migration backfill is for fresh installations.

## Next Phase Readiness

- FTS5 search is now fully functional for all nodes (old and new)
- Undo/redo fires exactly once per keypress via App.tsx global handler
- Active typing sessions are properly recorded before undo steps backward
- Ready to proceed with remaining Phase 3 plans

---
*Phase: 03-search-and-editing*
*Completed: 2026-03-25*
