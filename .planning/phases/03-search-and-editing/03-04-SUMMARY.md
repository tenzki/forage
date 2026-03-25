---
phase: 03-search-and-editing
plan: 04
subsystem: ui
tags: [tiptap, react, css, tauri, vitest, outliner, ai-nodes]

# Dependency graph
requires:
  - phase: 03-search-and-editing
    provides: TipTap StarterKit editor with Cmd+B/I/E shortcuts already wired
  - phase: 02-core-outliner
    provides: Bullet component, NodeRow renderer, react-arborist tree

provides:
  - Markdown inline formatting CSS (bold, italic, inline code) in TipTap editor
  - Sparkle icon (agent_response nodes) replacing bullet dot with purple SVG
  - Right-click context menu on AI nodes with Make mine conversion action
  - change_node_type Tauri IPC command (node_type column update only)
  - updateNodeLocally() store action for immediate local tree mutation
  - Bullet.test.tsx: 6 unit tests for sparkle vs dot rendering logic

affects:
  - 04-ai-agent — AI-generated nodes render with sparkle icon; Make mine enables user ownership
  - 03-search-and-editing — node display visual distinction complete

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Conditional bullet rendering: check node_type === 'agent_response' in Bullet.tsx, render SparkleIcon SVG vs bullet-dot span"
    - "Optimistic local mutation: updateNodeLocally() patches tree state directly without IPC round-trip"
    - "Context menu via useState + useEffect: fixed-position div rendered in React fragment outside node row"
    - "Direct invoke() for new IPC commands: bindings.ts regenerates only on cargo tauri dev/build, use invoke() directly"

key-files:
  created:
    - src/components/Outliner/Bullet.test.tsx
  modified:
    - src/components/Outliner/Bullet.tsx
    - src/components/Outliner/NodeRow.tsx
    - src/store/ipc.ts
    - src/store/treeStore.ts
    - src-tauri/src/commands/nodes.rs
    - src-tauri/src/lib.rs
    - src/main.tsx
    - src/style.css

key-decisions:
  - "SparkleIcon is an inline SVG component in Bullet.tsx — no external icon library needed for a single icon"
  - "Make mine uses optimistic local update (updateNodeLocally) + fire-and-forget IPC — sparkle disappears instantly"
  - "Global contextmenu preventDefault removed from main.tsx — context menu legitimately needed for AI nodes"
  - "change_node_type command updates only node_type + updated_at — minimal, dedicated command avoids touching update_node complexity"

patterns-established:
  - "AI node visual distinction: node_type check in Bullet.tsx, SparkleIcon SVG, .bullet-ai CSS class"
  - "Context menu pattern: useState for position, useEffect for outside-click/Escape close, rendered in React fragment"

requirements-completed: [EDIT-02, EDIT-04]

# Metrics
duration: 3min
completed: 2026-03-25
---

# Phase 03 Plan 04: Markdown Formatting + AI Node Styling Summary

**Markdown formatting CSS for bold/italic/code in TipTap, sparkle icon for agent_response nodes, and Make mine right-click context menu converting AI nodes to regular notes**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-25T10:33:54Z
- **Completed:** 2026-03-25T10:37:26Z
- **Tasks:** 1
- **Files modified:** 9

## Accomplishments
- Bold/italic/inline code formatting now renders visually in the TipTap editor (Cmd+B/I/E shortcuts via StarterKit were already working; only CSS was missing)
- agent_response nodes show a purple sparkle SVG icon instead of the bullet dot, providing immediate visual distinction for AI-generated content
- Right-clicking an AI node shows a context menu with Make mine option that instantly converts node_type to 'note' and removes the sparkle icon via optimistic local update
- New `change_node_type` Tauri command handles the lightweight node_type-only update
- 6 Bullet unit tests validate sparkle vs dot conditional rendering and toggle triangle behavior

## Task Commits

Each task was committed atomically:

1. **Task 1: Markdown formatting CSS + AI sparkle icon + context menu + Bullet test** - `135a914` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `src/components/Outliner/Bullet.tsx` - Added SparkleIcon SVG component, conditional render for agent_response nodes
- `src/components/Outliner/Bullet.test.tsx` - 6 Vitest + RTL tests for bullet rendering logic
- `src/components/Outliner/NodeRow.tsx` - Added onContextMenu handler, context menu state, Make mine action
- `src/store/ipc.ts` - Added changeNodeTypeIpc() using direct invoke()
- `src/store/treeStore.ts` - Added updateNodeLocally() for immediate node_type mutation
- `src-tauri/src/commands/nodes.rs` - Added change_node_type() Tauri command
- `src-tauri/src/lib.rs` - Registered change_node_type in collect_commands!
- `src/main.tsx` - Removed global contextmenu preventDefault
- `src/style.css` - Added strong/em/code marks CSS, .bullet-ai, .context-menu, .context-menu-item styles

## Decisions Made
- SparkleIcon implemented as inline SVG in Bullet.tsx — no icon library dependency for a single icon
- Make mine uses optimistic local mutation (updateNodeLocally) so the sparkle disappears immediately without waiting for IPC round-trip
- Global contextmenu prevention removed from main.tsx since AI nodes now have a legitimate context menu use case
- change_node_type is a dedicated minimal command (node_type + updated_at only) rather than extending the complex update_node dynamic SET logic

## Deviations from Plan

None - plan executed exactly as written.

One minor cleanup: unused `closeCtxMenu` function was removed after TypeScript caught it as unused during build. Not a deviation — was just cleanup before commit.

## Issues Encountered
- TypeScript TS6133 error for unused `closeCtxMenu` function declared in NodeRow.tsx — removed immediately, build passed on retry.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Formatting (EDIT-02) and AI node styling (EDIT-04) are complete
- AI agent nodes can be visually distinguished and converted to user-owned notes
- context menu pattern established for future right-click features
- No blockers for remaining Phase 03 plans or Phase 04 AI agent work

---
*Phase: 03-search-and-editing*
*Completed: 2026-03-25*
