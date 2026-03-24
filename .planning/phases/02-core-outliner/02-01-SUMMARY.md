---
phase: 02-core-outliner
plan: 01
subsystem: ui
tags: [react, vite, vitest, tauri, rust, fractional-indexing, tiptap, zustand, tree]

# Dependency graph
requires:
  - phase: 01-storage-foundation
    provides: SQLite node schema, IPC commands (create/get/update/delete/get_children), bindings.ts types

provides:
  - React 18 entry point (src/main.tsx) with createRoot mounting App component in Tauri WebView
  - move_node IPC command atomically updating parent_id + position (src-tauri/src/commands/nodes.rs)
  - TreeNode interface and extractText helper (src/types/tree.ts)
  - Tree utility functions: positionForInsertAfter, positionForMove, hydrateChildren, buildBreadcrumb (src/utils/treeHelpers.ts)
  - Vitest test suite (11 passing tests for tree helpers)
  - Integration tests for move_node (4 new tests, 12 total cargo tests passing)

affects: [02-02, 02-03, react-store, outliner-ui, drag-drop]

# Tech tracking
tech-stack:
  added:
    - react@19.2.4 + react-dom@19.2.4
    - react-arborist@3.4.3
    - @tiptap/react@3.20.5, @tiptap/starter-kit@3.20.5, @tiptap/core@3.20.5
    - zustand@5.0.12
    - @vitejs/plugin-react@4.7.0 (v4, compatible with vite 6)
    - vitest@4.1.1 + @testing-library/react@16.3.2 + jsdom@29.0.1
    - @types/react@19 + @types/react-dom@19
  patterns:
    - TDD: RED (failing tests) then GREEN (minimal implementation) for Rust and TS utilities
    - TreeNode interface wraps backend Node with nested children array for react-arborist
    - extractText walks ProseMirror JSON doc>paragraph>text nodes
    - positionForInsertAfter/positionForMove use generateKeyBetween from fractional-indexing
    - move_node Rust command: verify exists, UPDATE parent_id+position atomically, return updated node

key-files:
  created:
    - src/main.tsx
    - src/App.tsx
    - src/types/tree.ts
    - src/utils/treeHelpers.ts
    - src/utils/treeHelpers.test.ts
    - vitest.config.ts
    - tsconfig.json
  modified:
    - package.json
    - vite.config.ts
    - index.html
    - src-tauri/src/commands/nodes.rs
    - src-tauri/src/lib.rs
    - src-tauri/tests/db_tests.rs

key-decisions:
  - "@vitejs/plugin-react v4 required (not v6) — v6 requires vite 8, project uses vite 6"
  - "TreeNode.children is always TreeNode[] (never undefined) — Workflowy style where any node can have children"
  - "positionForMove excludes dragIds from sibling list before computing key — prevents dragged node's position from affecting the target range"
  - "move_node integration tests use raw SQL (not Tauri State) — consistent with Phase 1 test patterns"

patterns-established:
  - "Tree helper tests: use makeNode helper to build minimal TreeNode fixtures; test with real generateKeyBetween (no mocking)"
  - "Rust IPC command pattern: verify-exists then mutate then re-fetch for atomic correctness"

requirements-completed: [TREE-01, TREE-06]

# Metrics
duration: 6min
completed: 2026-03-24
---

# Phase 2 Plan 1: React Setup, move_node IPC, and Tree Helper Utilities

**React 18 + Vitest foundation with move_node Rust IPC command and fractional-indexing tree helpers, all tested**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-24T19:31:16Z
- **Completed:** 2026-03-24T19:36:50Z
- **Tasks:** 3
- **Files modified:** 13

## Accomplishments

- React 18 renders in Tauri WebView via vite build (src/main.tsx mounts App with createRoot)
- move_node Tauri IPC command atomically updates parent_id + position, registered in collect_commands!
- TreeNode type, extractText, positionForInsertAfter, positionForMove implemented with 11 passing Vitest tests
- 12 cargo integration tests pass (4 new move_node tests + existing 8 Phase 1 tests)

## Task Commits

Each task was committed atomically:

1. **Task 1: Install React ecosystem and set up project entry point** - `eadc03d` (feat)
2. **Task 2: Add move_node IPC command to Rust backend** - `f1953b3` (feat, TDD)
3. **Task 3: Create TreeNode types and tree helper utilities with tests** - `a7bce2c` (feat, TDD)

## Files Created/Modified

- `src/main.tsx` - React 18 entry point using createRoot, mounts App component
- `src/App.tsx` - Placeholder root component (replaced by OutlinerView in Plan 02)
- `src/types/tree.ts` - TreeNode interface, extractText (ProseMirror JSON walker), nodeToTreeNode
- `src/utils/treeHelpers.ts` - positionForInsertAfter, positionForMove (fractional-indexing), hydrateChildren, buildBreadcrumb
- `src/utils/treeHelpers.test.ts` - 11 Vitest tests: extractText (5), positionForInsertAfter (4), positionForMove (2)
- `vitest.config.ts` - Vitest config with jsdom environment and globals
- `tsconfig.json` - TypeScript config with react-jsx, bundler moduleResolution
- `vite.config.ts` - Added @vitejs/plugin-react v4 plugin
- `package.json` - Added React ecosystem deps, test script
- `index.html` - Updated script src to /src/main.tsx
- `src-tauri/src/commands/nodes.rs` - Added move_node command
- `src-tauri/src/lib.rs` - Registered move_node in collect_commands!
- `src-tauri/tests/db_tests.rs` - Added 4 move_node integration tests

## Decisions Made

- `@vitejs/plugin-react v4` used instead of v6 — v6 requires vite@8 but project uses vite@6; v4 is the correct compatible version
- `TreeNode.children` is always `TreeNode[]` — never undefined, enabling Workflowy-style any-node-can-have-children
- `positionForMove` excludes dragIds before calculating — avoids self-interference during drag
- Integration tests for move_node use raw SQL (not Tauri command layer) — consistent with Phase 1 test patterns and avoids Tauri State mock overhead

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Downgraded @vitejs/plugin-react from v6 to v4**

- **Found during:** Task 1 (vite build verification)
- **Issue:** @vitejs/plugin-react@6 requires vite@8 but project uses vite@6 — build failed with ERR_PACKAGE_PATH_NOT_EXPORTED for vite/internal
- **Fix:** Installed @vitejs/plugin-react@4 which is compatible with vite 6
- **Files modified:** package.json, package-lock.json
- **Verification:** vite build succeeds (194 kB bundle, 28 modules transformed)
- **Committed in:** eadc03d (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking dependency version conflict)
**Impact on plan:** Required fix to unblock build. No scope changes. All planned behavior delivered.

## Issues Encountered

- None beyond the @vitejs/plugin-react version conflict (auto-fixed)

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- React renders in WebView, Vitest is configured, tree types and helpers are ready
- Plan 02 can build OutlinerView component using react-arborist + TreeNode + position helpers
- Plan 03 can build the Zustand store using hydrateChildren + nodeToTreeNode
- move_node IPC is wired and bindings will be regenerated on next debug build

---
*Phase: 02-core-outliner*
*Completed: 2026-03-24*
