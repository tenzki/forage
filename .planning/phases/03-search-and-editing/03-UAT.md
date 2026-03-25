---
status: diagnosed
phase: 03-search-and-editing
source: 03-01-SUMMARY.md, 03-02-SUMMARY.md, 03-03-SUMMARY.md, 03-04-SUMMARY.md
started: 2026-03-25T13:00:00Z
updated: 2026-03-25T13:05:00Z
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

[testing complete]

## Tests

### 1. Cmd+K Search Overlay
expected: Press Cmd+K anywhere in the app. A centered search overlay appears above the tree. Type a query — results appear below with highlighted matching text and breadcrumb paths (e.g., "Home > Parent > Node"). Arrow keys navigate results. Press Enter on a result — overlay closes and the app zooms into that node. Press Escape to dismiss without navigating.
result: issue
reported: "cmd K popup shows, but search doesn't find anything"
severity: major

### 2. Full-Text Search Content
expected: Create a node with several words of text. Press Cmd+K and search for a word in the middle of the content (not the first word). The node appears in search results with the matching word highlighted in a snippet.
result: issue
reported: "search still doesn't return anything"
severity: major

### 3. Undo Structural Operation
expected: Create a new node (Enter), then press Cmd+Z. The newly created node disappears (undo create). Press Cmd+Shift+Z — the node reappears (redo). Try indent (Tab) then Cmd+Z — node returns to its original position.
result: issue
reported: "cmd z doesn't do anything"
severity: major

### 4. Undo Text Edit
expected: Click into a node and type several words. Wait 2 seconds (to create a group boundary). Type more words. Press Cmd+Z — the second group of words disappears but the first remains. Press Cmd+Z again — the first group disappears too.
result: issue
reported: "it's still not working"
severity: major

### 5. Undo Persists Across Restart
expected: Make several edits (create nodes, type text, indent). Quit and relaunch the app. Press Cmd+Z — the last operation is undone, proving undo history survived the restart.
result: skipped
reason: Undo not working at all (test 3/4), can't test persistence

### 6. Bold, Italic, Inline Code Formatting
expected: Click into a node. Select some text and press Cmd+B — text becomes bold. Select other text and press Cmd+I — text becomes italic. Select text and press Cmd+E — text renders as inline code with a distinct monospace/background style.
result: issue
reported: "it's applied when node is selected. when I focus away from it, it returns to normal format."
severity: major

### 7. Hashtag Inline with Autocomplete
expected: In a node, type "#" followed by at least 2 characters. An autocomplete dropdown appears showing existing tags that match. Select one — the hashtag appears as a styled inline element (distinct color, not editable as regular text). If no matching tags exist, typing the full word and pressing space/Enter creates a new tag.
result: issue
reported: "doesn't work"
severity: major

### 8. Tag Sidebar
expected: Press Cmd+\ — a left sidebar appears showing all hashtags used across your notes with counts next to each tag. Click a tag in the sidebar — the search overlay opens pre-filled with that tag name, showing all nodes containing that hashtag.
result: skipped
reason: Hashtags not working (test 7), can't test sidebar

### 9. Clickable Hashtag in Node
expected: In a node that has a #hashtag, click the hashtag text. The search overlay opens pre-filtered to show nodes containing that tag.
result: skipped
reason: Hashtags not working (test 7), can't test click behavior

### 10. AI Node Sparkle Icon
expected: If you have a node with node_type='agent_response' (can set via DB or create one for testing), it displays a purple sparkle icon instead of the regular bullet dot. The sparkle is visible when the node is collapsed or expanded.
result: skipped

### 11. Make Mine Context Menu
expected: Right-click on a node with the sparkle icon (agent_response node). A context menu appears with "Make mine" option. Click it — the sparkle icon immediately changes to a regular bullet dot, indicating the node is now a user-owned note.
result: skipped
reason: No agent_response nodes to test with

## Summary

total: 11
passed: 0
issues: 6
pending: 0
skipped: 5
## Gaps

- truth: "User can search across all nodes and see results with surrounding context, navigable without leaving keyboard"
  status: failed
  reason: "User reported: cmd K popup shows, but search doesn't find anything"
  severity: major
  test: 1
  root_cause: "Missing FTS5 backfill in migration 0002 — external content mode FTS5 does not auto-index pre-existing rows. Migration needs INSERT INTO nodes_fts(rowid, content_text) SELECT rowid, content_text FROM nodes."
  artifacts:
    - path: "src-tauri/migrations/0002_search_and_editing.sql"
      issue: "Missing FTS5 backfill statement for existing nodes"
  missing:
    - "Add backfill INSERT INTO nodes_fts(rowid, content_text) SELECT rowid, content_text FROM nodes to migration"
  debug_session: ".planning/debug/fts5-search-returns-no-results.md"

- truth: "User can search for a word in node content and see the node in results with the matching word highlighted"
  status: failed
  reason: "User reported: search still doesn't return anything"
  severity: major
  test: 2
  root_cause: "Same as test 1 — FTS5 backfill missing. Also: newly created nodes pass empty string as contentText, only indexed after first debounced save."
  artifacts:
    - path: "src-tauri/migrations/0002_search_and_editing.sql"
      issue: "Missing FTS5 backfill"
    - path: "src/store/treeStore.ts"
      issue: "createNode passes '' as contentText"
  missing:
    - "Add FTS5 backfill to migration"
  debug_session: ".planning/debug/fts5-search-returns-no-results.md"

- truth: "User can undo structural operations (create, indent, move) with Cmd+Z and redo with Cmd+Shift+Z"
  status: failed
  reason: "User reported: cmd z doesn't do anything"
  severity: major
  test: 3
  root_cause: "Double-fire: App.tsx capture handler AND OutlinerKeys Mod-z both call undo() on every Cmd+Z, consuming two undo steps per keypress. Also recordUndoStepIpc is fire-and-forget — silent failures leave empty undo stack."
  artifacts:
    - path: "src/App.tsx"
      issue: "Capture-phase Cmd+Z handler fires alongside OutlinerKeys Mod-z"
    - path: "src/components/Outliner/NodeEditor.tsx"
      issue: "OutlinerKeys Mod-z is redundant with App.tsx global handler"
  missing:
    - "Remove Mod-z/Mod-Shift-z from OutlinerKeys OR remove from App.tsx global handler"
  debug_session: ".planning/debug/undo-cmd-z-not-working.md"

- truth: "User can undo text edits with Cmd+Z grouped by typing pauses"
  status: failed
  reason: "User reported: it's still not working"
  severity: major
  test: 4
  root_cause: "Active typing group is never recorded to DB — undo() calls undoTracker.flush() but discards the result instead of calling recordUndoStepIpc with it. The current typing session is permanently unrecoverable."
  artifacts:
    - path: "src/store/treeStore.ts"
      issue: "undo() discards pending flush result instead of recording it via IPC"
  missing:
    - "In undo(), when flush() returns pending group, call recordUndoStepIpc with before/after snapshots before calling undoStepIpc"
  debug_session: ".planning/debug/undo-cmd-z-not-working.md"

- truth: "Bold, italic, and inline code formatting persists when node loses focus"
  status: failed
  reason: "User reported: it's applied when node is selected. when I focus away from it, it returns to normal format."
  severity: major
  test: 6
  root_cause: "Non-editing nodes render node.data.name (plain text from extractText()) instead of ProseMirror JSON content. extractText() strips all marks. The rich content is saved correctly but never rendered when the node is not being edited."
  artifacts:
    - path: "src/components/Outliner/NodeRow.tsx"
      issue: "Line 107 renders {node.data.name} — plain text, no formatting"
    - path: "src/types/tree.ts"
      issue: "extractText() strips marks, producing plain string"
  missing:
    - "Replace plain <span> in NodeRow with generateHTML(node.data.content, extensions) or similar rich text rendering for non-editing nodes"
  debug_session: ".planning/debug/formatting-lost-on-blur.md"

- truth: "User can type #hashtag inline and see autocomplete dropdown with matching tags"
  status: failed
  reason: "User reported: doesn't work"
  severity: major
  test: 7
  root_cause: "Two issues: (1) Query length gate requires 2 chars after # but popup renders null when items is empty — popup invisible until 3 chars typed. (2) On fresh install no tags exist, so IPC always returns empty array and popup never shows. No 'create new tag' option."
  artifacts:
    - path: "src/extensions/HashtagNode.tsx"
      issue: "Line 209: query.length < 2 guard too strict; SuggestionPopup returns null on empty items"
  missing:
    - "Lower query length gate to 0 or 1"
    - "Show 'create new tag' option when no existing tags match"
  debug_session: ".planning/debug/hashtag-autocomplete-not-triggering.md"
