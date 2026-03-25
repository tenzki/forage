---
phase: 03-search-and-editing
plan: 01
subsystem: database, search, ui
tags: [sqlite-fts5, rust, cmdk, tauri-ipc, react, vitest, full-text-search]

# Dependency graph
requires:
  - phase: 02-core-outliner
    provides: TipTap NodeEditor with extractText(), updateContent IPC, treeStore with zoomIn()

provides:
  - SQLite FTS5 virtual table (nodes_fts) with BM25 ranking and unicode61 tokenizer
  - FTS5 sync triggers (INSERT/UPDATE/DELETE on nodes) for automatic index maintenance
  - content_text column on nodes table populated by frontend extractText() on every save
  - search_nodes Rust IPC command with snippet(nodes_fts) highlighting
  - get_ancestors Rust IPC command for breadcrumb navigation
  - SearchOverlay.tsx (cmdk Command.Dialog) with Cmd+K trigger, 200ms debounce, shouldFilter=false
  - SearchResultItem.tsx with breadcrumb path and FTS5 <mark> snippet rendering
  - undo_history and undo_pointer tables for Phase 3 Plan 02
  - node_tags table for Phase 3 Plan 03
affects:
  - 03-search-and-editing/03-02 (undo/redo uses undo_history table created here)
  - 03-search-and-editing/03-03 (hashtag system uses node_tags table created here)

# Tech tracking
tech-stack:
  added:
    - cmdk ^1.1.1 (headless command palette — powers Cmd+K overlay)
  patterns:
    - FTS5 external content table (content='nodes', content_rowid='rowid') with three sync triggers
    - Runtime sqlx::query() for all FTS5 queries (NOT query! macro — FTS5 is not introspectable)
    - JOIN nodes_fts to nodes via n.rowid = nodes_fts.rowid (NOT n.id — FTS5 uses INTEGER rowid)
    - shouldFilter=false on cmdk Command.Dialog when filtering is handled server-side
    - window.addEventListener('keydown', handler, { capture: true }) for Cmd+K to bypass TipTap stopPropagation
    - Direct invoke() in ipc.ts for commands where bindings.ts is stale (not regenerated yet)

key-files:
  created:
    - src-tauri/migrations/0002_search_and_editing.sql
    - src-tauri/src/commands/search.rs
    - src/components/Search/SearchOverlay.tsx
    - src/components/Search/SearchResultItem.tsx
    - src/components/Search/SearchOverlay.test.tsx
    - src/test-setup.ts
  modified:
    - src-tauri/src/commands/nodes.rs (added content_text param to create_node and update_node)
    - src-tauri/src/commands/mod.rs (added pub mod search)
    - src-tauri/src/lib.rs (registered search_nodes and get_ancestors in collect_commands!)
    - src-tauri/tests/db_tests.rs (added test_search_nodes, test_search_nodes_fts_update_trigger)
    - src/store/ipc.ts (added searchNodesIpc, getAncestorsIpc; switched create/update to direct invoke)
    - src/store/treeStore.ts (updateContent passes content_text to updateNodeIpc)
    - src/App.tsx (Cmd+K listener, SearchOverlay rendered)
    - src/style.css (search overlay and result item CSS)
    - vitest.config.ts (added setupFiles for ResizeObserver polyfill)

key-decisions:
  - "FTS5 with shouldFilter=false: cmdk built-in filtering disabled because search is done server-side via FTS5 — client-side re-filtering by UUID would hide all results"
  - "Direct invoke() for create_node/update_node in ipc.ts: bindings.ts is gitignored and regenerates only on cargo tauri dev/build — direct invoke bypasses stale bindings with new content_text parameter"
  - "ResizeObserver polyfill in test-setup.ts: cmdk uses ResizeObserver internally, jsdom doesn't provide it — polyfill required for all cmdk tests"
  - "content_text extracted on frontend: Rust has no ProseMirror JSON parser; extractText() already exists in types/tree.ts and is the canonical text extractor"

patterns-established:
  - "Pattern: FTS5 external content with manual triggers — nodes_fts points to nodes table, three triggers (ai/ad/au) keep FTS index in sync automatically on any nodes write"
  - "Pattern: ipc.ts direct invoke for Rust commands with new params — avoids stale bindings.ts until next cargo tauri dev/build regeneration"
  - "Pattern: cmdk with shouldFilter=false for server-driven search — prevents UUID-based items from being hidden by client-side filter"

requirements-completed: [TREE-05]

# Metrics
duration: 30min
completed: 2026-03-25
---

# Phase 3 Plan 01: FTS5 Search Infrastructure + Cmd+K Overlay Summary

**SQLite FTS5 full-text search with BM25 ranking, Cmd+K cmdk overlay, breadcrumb navigation, and all Phase 3 database tables (FTS5, undo_history, node_tags)**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-03-25T10:00:00Z
- **Completed:** 2026-03-25T10:30:40Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments

- Full FTS5 infrastructure: migration creates nodes_fts virtual table, content_text column, and three sync triggers that keep the FTS index consistent on every nodes INSERT/UPDATE/DELETE
- Rust search_nodes IPC command with prefix matching ("query*"), BM25 ranking via ORDER BY rank, and FTS5 snippet() with `<mark>` HTML highlighting — plus get_ancestors for breadcrumb paths
- Cmd+K search overlay using cmdk Command.Dialog with capture-phase listener to intercept even when TipTap is active, 200ms debounce, and shouldFilter=false for server-side filtering
- All Phase 3 database tables created: nodes_fts (FTS5), undo_history with operation CHECK constraint, undo_pointer initialized to 0, node_tags with composite PK and tag index
- 5 SearchOverlay unit tests pass; 2 Rust integration tests (test_search_nodes, test_search_nodes_fts_update_trigger) pass; npm run build clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Database migration + Rust search backend + content_text sync** - `89b1e3c` (feat)
2. **Task 2: Cmd+K search overlay UI with cmdk + SearchOverlay test** - `7925e6c` (feat)

## Files Created/Modified

- `src-tauri/migrations/0002_search_and_editing.sql` - FTS5 table, triggers, undo_history, undo_pointer, node_tags
- `src-tauri/src/commands/search.rs` - search_nodes (FTS5 BM25) and get_ancestors IPC commands
- `src-tauri/src/commands/mod.rs` - Added pub mod search
- `src-tauri/src/lib.rs` - Registered search_nodes and get_ancestors in collect_commands!
- `src-tauri/src/commands/nodes.rs` - Added content_text Option<String> to create_node and update_node
- `src-tauri/tests/db_tests.rs` - Two new integration tests for FTS5 search and trigger behavior
- `src/store/ipc.ts` - Added searchNodesIpc, getAncestorsIpc; switched create/update to direct invoke
- `src/store/treeStore.ts` - updateContent extracts and passes content_text to updateNodeIpc
- `src/App.tsx` - Cmd+K listener (capture:true), SearchOverlay rendered
- `src/style.css` - Search overlay CSS (backdrop, modal, result items, mark highlight)
- `src/components/Search/SearchOverlay.tsx` - cmdk Command.Dialog with shouldFilter=false
- `src/components/Search/SearchResultItem.tsx` - Breadcrumb + FTS5 snippet with dangerouslySetInnerHTML
- `src/components/Search/SearchOverlay.test.tsx` - 5 tests: open/close, keyboard, results rendering
- `src/test-setup.ts` - ResizeObserver polyfill for jsdom
- `vitest.config.ts` - setupFiles added

## Decisions Made

- **shouldFilter=false on cmdk**: cmdk's built-in filter compares item `value` props against the input — since items use UUIDs as values and search is done by FTS5, all results were being hidden. Disabling cmdk filtering is the correct pattern for server-driven search.
- **Direct invoke() for create_node/update_node**: bindings.ts is gitignored and regenerates only on `cargo tauri dev/build`. The new `content_text` parameter would be silently dropped by stale bindings. Using `invoke()` directly bypasses this until next regeneration.
- **content_text extracted on frontend**: Rust has no ProseMirror JSON parser; `extractText()` already exists in `types/tree.ts`. Frontend extraction keeps Rust decoupled from TipTap JSON structure.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] cmdk shouldFilter=false required for server-side search**
- **Found during:** Task 2 (SearchOverlay tests)
- **Issue:** cmdk filters Command.Item by comparing `value` prop against input value. Items used UUID as value — cmdk hid all results because "test-node-1" doesn't match "quick"
- **Fix:** Added `shouldFilter={false}` to Command.Dialog — search filtering is delegated entirely to FTS5
- **Files modified:** src/components/Search/SearchOverlay.tsx
- **Committed in:** 7925e6c (Task 2 commit)

**2. [Rule 3 - Blocking] ResizeObserver polyfill needed for cmdk in jsdom**
- **Found during:** Task 2 (SearchOverlay tests failing with "ResizeObserver is not defined")
- **Issue:** cmdk uses ResizeObserver internally; jsdom test environment doesn't provide it
- **Fix:** Created src/test-setup.ts with a no-op ResizeObserver polyfill; added setupFiles to vitest.config.ts
- **Files modified:** src/test-setup.ts (created), vitest.config.ts
- **Committed in:** 7925e6c (Task 2 commit)

**3. [Rule 1 - Bug] Pre-existing TypeScript unused variable errors blocking npm run build**
- **Found during:** Task 2 (build verification)
- **Issue:** `noUnusedLocals: true` in tsconfig.json caused build failure on pre-existing unused variables: `handleEmptyAreaClick` in NodeRow.tsx, `node` param in OutlinerView.tsx CustomRow, `React` import in main.tsx, and unused imports in auto-generated bindings.ts
- **Fix:** Removed unused variable declarations; added `@ts-nocheck` to gitignored bindings.ts (auto-generated file, will be overwritten on next cargo tauri dev)
- **Files modified:** src/components/Outliner/NodeRow.tsx, src/components/Outliner/OutlinerView.tsx, src/main.tsx
- **Committed in:** 7925e6c (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 bug)
**Impact on plan:** All three auto-fixes required for tests to pass and build to succeed. No scope creep.

## Issues Encountered

- The FTS5 JOIN must use `n.rowid = nodes_fts.rowid` (integer rowid), not `n.id` — noted in research but worth re-emphasizing: UUID TEXT PK and integer rowid are distinct
- cmdk uses `value` prop on Command.Item for built-in filtering — the plan's approach of using UUIDs as values requires `shouldFilter={false}`

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- FTS5 infrastructure complete — all search queries will work immediately after `cargo tauri dev` runs the migration
- undo_history and undo_pointer tables ready for Phase 3 Plan 02 (persistent undo/redo)
- node_tags table ready for Phase 3 Plan 03 (hashtag system)
- content_text populated on every create/update — FTS index stays in sync via triggers

---
*Phase: 03-search-and-editing*
*Completed: 2026-03-25*
