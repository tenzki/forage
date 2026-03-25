---
status: complete
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
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""

- truth: "User can type #hashtag inline and see autocomplete dropdown with matching tags"
  status: failed
  reason: "User reported: doesn't work"
  severity: major
  test: 7
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""

- truth: "Bold, italic, and inline code formatting persists when node loses focus"
  status: failed
  reason: "User reported: it's applied when node is selected. when I focus away from it, it returns to normal format."
  severity: major
  test: 6
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""

- truth: "User can undo text edits with Cmd+Z grouped by typing pauses"
  status: failed
  reason: "User reported: it's still not working"
  severity: major
  test: 4
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""

- truth: "User can undo structural operations (create, indent, move) with Cmd+Z and redo with Cmd+Shift+Z"
  status: failed
  reason: "User reported: cmd z doesn't do anything"
  severity: major
  test: 3
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""

- truth: "User can search for a word in node content and see the node in results with the matching word highlighted"
  status: failed
  reason: "User reported: search still doesn't return anything"
  severity: major
  test: 2
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""
