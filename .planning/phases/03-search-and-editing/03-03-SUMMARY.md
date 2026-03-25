---
phase: 03-search-and-editing
plan: 03
subsystem: ui
tags: [tiptap, hashtag, suggestion, sqlite, tag-indexing, rust, react, zustand, sidebar]

# Dependency graph
requires:
  - phase: 03-01
    provides: node_tags table migration, FTS5 search infrastructure
  - phase: 02-03
    provides: TipTap NodeEditor with OutlinerKeys extension

provides:
  - Inline #hashtag TipTap Node extension with autocomplete suggestion popup
  - Rust IPC commands: get_all_tags, get_tags_matching, sync_node_tags
  - Toggleable tag sidebar showing all tags with counts (Cmd+\)
  - Tag sync to node_tags table on content save (after 300ms debounce)
  - Clicking hashtag opens search pre-filtered to that tag

affects:
  - 04-ai-integration (hashtags can tag AI-generated content)
  - future search phases (tag-filtered search already wired)

# Tech tracking
tech-stack:
  added:
    - "@tiptap/suggestion@3.20.5 — # trigger autocomplete"
  patterns:
    - "Atom Node for hashtags (not Mark) — prevents partial text selection of hashtags"
    - "React portal for suggestion popup — renders to document.body to avoid overflow clipping"
    - "registerTagClickHandler in Zustand store — avoids prop drilling through react-arborist tree"
    - "extractHashtags() walks ProseMirror JSON — keeps Rust decoupled from TipTap schema"
    - "syncNodeTagsIpc full-replace strategy — DELETE all + INSERT new per node"

key-files:
  created:
    - src-tauri/src/commands/tags.rs
    - src/extensions/HashtagNode.tsx
    - src/extensions/HashtagNode.test.tsx
    - src/components/TagSidebar/TagSidebar.tsx
    - src/components/TagSidebar/TagList.tsx
  modified:
    - src-tauri/src/commands/mod.rs
    - src-tauri/src/lib.rs
    - src-tauri/tests/db_tests.rs
    - src/store/ipc.ts
    - src/store/treeStore.ts
    - src/components/Outliner/NodeEditor.tsx
    - src/components/Search/SearchOverlay.tsx
    - src/App.tsx
    - src/style.css

key-decisions:
  - "HashtagNode as atom Node (not Mark) — hashtags are atomic units; Marks would allow partial selection"
  - "Suggestion popup via React portal + react-dom/client createRoot — avoids overflow clipping in editor"
  - "registerTagClickHandler in Zustand store — cleanest path to pass callback through react-arborist"
  - "extractHashtags() walks ProseMirror JSON on frontend — Rust stays decoupled from TipTap schema"
  - "syncNodeTagsIpc full-replace strategy (DELETE + INSERT) — simple and correct, avoids diff complexity"
  - "initialQuery prop on SearchOverlay + pre-fill useEffect — tag sidebar click pre-populates search"

patterns-established:
  - "Pattern: Atom inline nodes for structured content (hashtags, mentions) — use Node not Mark"
  - "Pattern: Store-registered callbacks for cross-component communication in react-arborist trees"

requirements-completed: [EDIT-03]

# Metrics
duration: 10min
completed: 2026-03-25
---

# Phase 03 Plan 03: Hashtag System Summary

**Custom TipTap atom Node extension for inline #tags with autocomplete, Rust tag IPC (get_all_tags, get_tags_matching, sync_node_tags), and toggleable tag sidebar with Cmd+\**

## Performance

- **Duration:** 10 min
- **Started:** 2026-03-25T11:50:00Z
- **Completed:** 2026-03-25T12:00:00Z
- **Tasks:** 2
- **Files modified:** 14

## Accomplishments
- Rust tag IPC commands compile and pass integration test (test_tag_indexing)
- HashtagNode TipTap extension renders #tags as atomic blue inline nodes with click-to-search
- Autocomplete suggestion popup appears after typing # + 2 characters, renders via React portal
- Tag sidebar loads all tags with counts from DB, toggleable with Cmd+\
- Tags are synced to node_tags table on every debounced content save
- 8 HashtagNode unit tests + 1 Rust integration test, all 47 total tests pass, build clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Rust tag IPC commands + HashtagNode TipTap extension + HashtagNode test** - `9dca0a6` (feat)
2. **Task 2: Tag sidebar + NodeEditor integration + tag sync on content save** - `e9b8c81` (feat)

**Plan metadata:** (pending)

## Files Created/Modified
- `src-tauri/src/commands/tags.rs` - Rust IPC: get_all_tags, get_tags_matching, sync_node_tags with TagCount struct
- `src/extensions/HashtagNode.tsx` - TipTap Node extension with Suggestion and React portal popup
- `src/extensions/HashtagNode.test.tsx` - 8 unit tests covering insertion, JSON round-trip, renderHTML, atom/inline spec
- `src/components/TagSidebar/TagSidebar.tsx` - Toggleable sidebar, loads tags on open via getAllTagsIpc
- `src/components/TagSidebar/TagList.tsx` - Tag list rendering with count badges
- `src-tauri/src/commands/mod.rs` - Added tags module
- `src-tauri/src/lib.rs` - Registered 3 tag IPC commands
- `src-tauri/tests/db_tests.rs` - Added test_tag_indexing integration test
- `src/store/ipc.ts` - Added getAllTagsIpc, getTagsMatchingIpc, syncNodeTagsIpc wrappers
- `src/store/treeStore.ts` - Added extractHashtags(), syncNodeTagsIpc call in updateContent, registerTagClickHandler
- `src/components/Outliner/NodeEditor.tsx` - Added HashtagNode extension with onTagClick via store
- `src/components/Search/SearchOverlay.tsx` - Added initialQuery prop for pre-fill on open
- `src/App.tsx` - Added sidebarOpen state, Cmd+\ shortcut, tag click handler registration
- `src/style.css` - Added .hashtag, .tag-sidebar, .tag-list-item, .suggestion-popup CSS

## Decisions Made
- HashtagNode as atom Node (not Mark) — prevents partial selection of hashtag text
- Suggestion popup via React portal (react-dom/client createRoot) — avoids overflow clipping in nested editor
- registerTagClickHandler in Zustand store — avoids prop drilling through react-arborist which doesn't support arbitrary props
- extractHashtags() walks ProseMirror JSON on frontend — consistent with existing extractText() pattern, keeps Rust decoupled
- Full-replace strategy for sync_node_tags (DELETE + INSERT per node) — simple, idempotent, correct

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript type errors in HashtagNode.tsx and test**
- **Found during:** Task 1 and 2 (build verification)
- **Issue:** `NodeViewProps.extension` type mismatch, unused vars, `clientRect` undefined vs null
- **Fix:** Cast `extension.options` to `HashtagNodeOptions`, remove unused vars, coalesce undefined to null with `??`
- **Files modified:** src/extensions/HashtagNode.tsx, src/extensions/HashtagNode.test.tsx
- **Verification:** `npm run build` passes without type errors
- **Committed in:** e9b8c81 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — TypeScript type errors)
**Impact on plan:** Only type correctness fix required. No scope creep.

## Issues Encountered
- TipTap v3's `NodeViewProps.extension` has a `Node<any,any>` type that doesn't accept a plain options-only interface — worked around by casting to `HashtagNodeOptions` in the node view function.

## Next Phase Readiness
- Hashtag system complete — EDIT-03 delivered
- Tags are indexed in node_tags table and queryable for future search enhancements
- Phase 04 (AI integration) can tag AI-generated nodes with #hashtags natively

---
*Phase: 03-search-and-editing*
*Completed: 2026-03-25*
