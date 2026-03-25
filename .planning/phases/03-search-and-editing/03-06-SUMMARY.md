---
phase: 03-search-and-editing
plan: 06
subsystem: outliner-ui
tags: [rich-text, formatting, hashtag, autocomplete, tiptap, generateHTML]
dependency_graph:
  requires: []
  provides: [rich-text-display, hashtag-autocomplete-create]
  affects: [NodeRow, HashtagNode, NodeEditor]
tech_stack:
  added: []
  patterns: [generateHTML for read-only rich text display, __create__ prefix convention for "create new" suggestion items]
key_files:
  created: []
  modified:
    - src/components/Outliner/NodeRow.tsx
    - src/extensions/HashtagNode.tsx
    - src/style.css
    - src/components/Outliner/NodeEditor.tsx
decisions:
  - "readOnlyExtensions array defined outside component to avoid re-creation on each render"
  - "StarterKit undoRedo:false replaces history:false (API rename in installed version)"
  - "__create__:tagname prefix convention signals create action without a separate type — keeps items: string[] contract intact"
metrics:
  duration: 20min
  completed: 2026-03-25
  tasks_completed: 2
  files_modified: 4
---

# Phase 03 Plan 06: Rich Text Display and Hashtag Autocomplete Fix Summary

**One-liner:** Switched non-editing nodes from plain-text `name` to `generateHTML`-rendered rich content, and lowered hashtag autocomplete threshold to 1 char with "Create #tag" fallback for empty databases.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Render rich text for non-editing nodes | e24acf0 | NodeRow.tsx, style.css, NodeEditor.tsx |
| 2 | Fix hashtag autocomplete threshold and add create-new-tag option | 298dbf0 | HashtagNode.tsx, style.css |

## What Was Built

### Task 1: Rich Text Display for Non-Editing Nodes

`NodeRow.tsx` previously rendered `node.data.name` (plain text via `extractText()`) for all non-editing nodes. This caused bold, italic, and code formatting to be lost the moment a user clicked away from a node.

The fix:
- Imports `generateHTML` from `@tiptap/core` and the same extensions as `NodeEditor` (`StarterKit` + `HashtagNode`)
- Defines `readOnlyExtensions` outside the component (stable reference, no re-creation on re-renders)
- When `node.data.content` is present, renders `dangerouslySetInnerHTML` with `generateHTML` output using class `node-text--rich`
- Falls back to `node.data.name` plain text when `content` is null/undefined (e.g., old nodes without content)
- Added CSS: `.node-text--rich p { margin: 0; display: inline }` prevents block-level paragraph gaps in the single-line outliner; `.node-text--rich code` matches editor code style

### Task 2: Hashtag Autocomplete Threshold + Create-New-Tag

`HashtagNode.tsx` `items` callback had `query.length < 2` guard preventing popup from appearing on single-character queries (e.g., `#t`). An empty database would also return an empty array, hiding the popup entirely.

The fixes:
- Lowered threshold to `query.length < 1` — popup now appears after typing `#` + any character
- After fetching `getTagsMatchingIpc(query)`, checks for exact match; if none found, appends `__create__:${query}` to the items array
- On IPC error, returns `[__create__:${query}]` so the user can still create tags offline
- Updated `command` callback: strips `__create__:` prefix before inserting hashtag node, so the actual tag stored is clean (e.g., `t` not `__create__:t`)
- Updated `SuggestionPopup` render: detects `__create__:` prefix, shows "Create #tagname" label instead of `#__create__:tagname`
- Added `.suggestion-item--create` CSS class with blue color and a divider to visually distinguish the create option from existing-tag matches

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed pre-existing StarterKit `history` option TS error in NodeEditor.tsx**
- **Found during:** Task 1 build verification
- **Issue:** `NodeEditor.tsx` used `history: false` in `StarterKit.configure()` which is not a valid option in the installed version — the API was renamed to `undoRedo`
- **Fix:** Changed `history: false` to `undoRedo: false` in `NodeEditor.tsx` (line 197)
- **Files modified:** `src/components/Outliner/NodeEditor.tsx`
- **Commit:** e24acf0 (bundled with Task 1)

**2. [Rule 1 - Bug] Removed `history: false` from readOnlyExtensions (plan code sample)**
- **Found during:** Task 1 implementation
- **Issue:** Plan's code sample included `history: false` in `readOnlyExtensions` which causes the same TS error
- **Fix:** Omitted `history`/`undoRedo` from `readOnlyExtensions` entirely — read-only display doesn't need undo history management
- **Files modified:** `src/components/Outliner/NodeRow.tsx`
- **Commit:** e24acf0

## Self-Check: PASSED

All files confirmed present. Both commits (e24acf0, 298dbf0) confirmed in git log.
