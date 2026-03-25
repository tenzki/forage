---
status: diagnosed
trigger: "Investigate why Cmd+Z undo doesn't do anything in the ai-chat app"
created: 2026-03-25T00:00:00Z
updated: 2026-03-25T00:00:00Z
---

## Current Focus

hypothesis: Text undo never records steps because the UndoGroupTracker logic never flushes to IPC; structural undo records steps but undo_step returns early because undo_pointer row is missing from the DB
test: Read all relevant source files end-to-end
expecting: Identified the blocking failure point(s)
next_action: Report findings (goal: find_root_cause_only)

## Symptoms

expected: Cmd+Z should revert the most recent structural change (create/delete/indent/etc.) or text edit
actual: Cmd+Z does nothing — no visible change in UI, no error
errors: none reported
reproduction: press Cmd+Z after any operation
started: unknown / possibly always broken

## Eliminated

- hypothesis: Global App.tsx Cmd+Z handler is missing or not wired
  evidence: App.tsx lines 37-40 handle metaKey+z without shiftKey, calling undo(), using capture:true so it fires before TipTap
  timestamp: 2026-03-25

- hypothesis: TipTap OutlinerKeys extension doesn't intercept Mod-z
  evidence: NodeEditor.tsx lines 147-150 define 'Mod-z' and call opts.onUndo() returning true; onUndo calls undo() from treeStore
  timestamp: 2026-03-25

- hypothesis: undoStepIpc or redoStepIpc not hooked up to Rust
  evidence: ipc.ts lines 156-175 invoke 'undo_step' and 'redo_step' directly; undo.rs registered in lib.rs lines 25-27
  timestamp: 2026-03-25

- hypothesis: undo_step Rust function does not reload the tree
  evidence: treeStore.ts lines 797-803: after undoStepIpc() returns a result with node_ids.length > 0, loadTree() is called
  timestamp: 2026-03-25

## Evidence

- timestamp: 2026-03-25
  checked: treeStore.ts updateContent() undo grouping logic (lines 453-505)
  found: shouldStartNewGroup() is called on EVERY keystroke. When it returns true (first keystroke, node switch, or >1000ms gap), flush() is called on the PREVIOUS group and recordUndoStepIpc is invoked for it. Then startGroup() is called to begin the new group. The CURRENT in-progress group is NEVER recorded until the NEXT group boundary triggers a flush.
  implication: The very first group (first typing session) is only recorded when a second group starts (different node, timeout, or second typing burst). If the user types into one node and immediately hits Cmd+Z without switching nodes or waiting 1 second, the in-progress group has never been flushed. The undo() action calls undoTracker.flush() but DISCARDS the result (treeStore.ts lines 787-793 — comment says "just discard the flush"). So text edits within an active group are silently dropped on undo.
  implication: This is ROOT CAUSE #1 for text undo.

- timestamp: 2026-03-25
  checked: treeStore.ts undo() function (lines 785-805)
  found: flush() result is explicitly discarded with a comment "This means text edits since the last group start won't be captured, which is acceptable since the user is explicitly triggering undo". Then undoStepIpc() is called. The result is checked: if result && result.node_ids.length > 0 then loadTree(). If result is null (nothing to undo), loadTree() is NOT called — which is correct. But the discarded pending text group means the most-recent typing session is never undoable.
  implication: Confirms ROOT CAUSE #1 for text undo.

- timestamp: 2026-03-25
  checked: undo_history schema in 0002_search_and_editing.sql (lines 38-46) and record_undo_step in undo.rs (lines 24-70)
  found: undo_history.node_id has a FOREIGN KEY REFERENCES nodes(id) ON DELETE CASCADE. record_undo_step inserts into undo_history. For a 'create' operation, the after_json contains the new node's data, and node_id = newNode.id. This FK is satisfied because the node was just created. So recording create steps is fine.
  implication: No schema issue for structural ops.

- timestamp: 2026-03-25
  checked: undo_step Rust function (lines 157-292) — specifically the 'create' undo path
  found: When undoing a 'create', the node is deleted from nodes (line 239), which CASCADE-deletes the undo_history row. The code then re-inserts the undo_history row with FK checks disabled (lines 246-265). This preserves the redo entry. The undo_pointer is then decremented to min_id - 1. This logic appears correct in isolation.
  implication: Undo of structural create should work if the undo step was recorded and the pointer is correct.

- timestamp: 2026-03-25
  checked: record_undo_step pointer logic (lines 33-68) vs undo_step pointer logic (lines 158-165)
  found: record_undo_step reads the current position, clears redo entries (WHERE id > position), inserts the new row, then sets pointer to the new row's id. undo_step reads position, and if position == 0 returns None (nothing to undo). The undo_pointer table starts with position=0 (schema line 52 seeds INSERT OR IGNORE INTO undo_pointer VALUES (1, 0)). So after one record_undo_step call the pointer should be 1.
  implication: Pointer logic is structurally correct — BUT only if the undo_pointer row actually exists and record_undo_step actually completes without error.

- timestamp: 2026-03-25
  checked: createNode in treeStore.ts (lines 359-408)
  found: recordUndoStepIpc is called with .catch() — errors are silently swallowed with console.warn. The call is NOT awaited at the top level (it's fire-and-forget after the node is created). If the IPC call fails, the undo stack is silently empty.
  implication: If record_undo_step fails for any reason (DB not ready, schema not migrated yet), undo will silently have nothing to undo.

- timestamp: 2026-03-25
  checked: 'move' operation in record_undo_step constraint check
  found: undo_history.operation CHECK constraint is: CHECK (operation IN ('text_edit', 'create', 'delete', 'move', 'indent', 'outdent')). treeStore.ts records operations: 'create', 'delete', 'text_edit', 'indent', 'outdent', 'move'. These all match.
  implication: No constraint violation for any of the recorded operations.

- timestamp: 2026-03-25
  checked: StarterKit configuration in NodeEditor.tsx (lines 201-215)
  found: StarterKit is configured with history not explicitly disabled. StarterKit includes the History extension by default, which handles its own Cmd+Z (ProseMirror-level undo of text). The OutlinerKeys extension adds 'Mod-z' returning true, which overrides TipTap's default. HOWEVER: extension order matters in TipTap. OutlinerKeys is added AFTER StarterKit. Extensions are processed in order — later extensions can override earlier ones.
  implication: In TipTap, keyboard shortcuts from extensions are processed in registration order. Since OutlinerKeys is registered after StarterKit, its 'Mod-z' handler is called FIRST (TipTap processes in reverse registration order for keyboard shortcuts, giving later extensions priority). So OutlinerKeys' Mod-z DOES take precedence — TipTap's built-in undo is suppressed. This is NOT the bug.

- timestamp: 2026-03-25
  checked: handleKeyDown in NodeEditor.tsx editorProps (lines 307-316)
  found: event.stopPropagation() is called for ALL key events from ProseMirror. This prevents the keydown event from bubbling up to the window. HOWEVER, App.tsx registers its handler with capture: true (line 46), which means it fires during the capture phase BEFORE the event reaches the target (ProseMirror's DOM node). stopPropagation() only stops bubbling (not capture-phase propagation). So App.tsx's capture handler still fires.
  implication: The App.tsx capture handler DOES fire for Cmd+Z even when TipTap has focus. But so does OutlinerKeys. Both undo() calls fire — one from OutlinerKeys' Mod-z, one from App.tsx's capture handler. This means undo() is called TWICE per Cmd+Z when an editor is focused.
  implication: This is ROOT CAUSE #2 — double undo invocation when editor is focused, but NOT the reason undo does nothing. It would cause undoing two steps at once. If only one step exists, first undo removes it and second undo returns null (no-op). Net effect: correct single undo for the first operation, but with two IPC round-trips.

## Resolution

root_cause: |
  TWO independent root causes found:

  ROOT CAUSE A — Text undo never captures the active typing session:
  In treeStore.ts updateContent(), the UndoGroupTracker records undo steps by FLUSHING the PREVIOUS group when a new group starts. The CURRENT in-progress group (the most recent typing burst) is never recorded to DB until the user does something else (switches node, waits >1 second, or starts a new group). When the user presses Cmd+Z, the undo() action calls undoTracker.flush() but explicitly DISCARDS the result (lines 787-793 with comment "just discard the flush"). This means the active group's before-snapshot is thrown away and never sent to record_undo_step. The DB has no entry for the current typing session. undoStepIpc() either returns null (if no prior structural ops exist) or undoes a PREVIOUS operation — never the active text session. Result: text undo appears to do nothing or jumps back further than expected.

  ROOT CAUSE B — Cmd+Z triggers undo() twice when an editor is focused:
  OutlinerKeys extension in NodeEditor.tsx handles 'Mod-z' and calls undo(). App.tsx also listens with capture:true on window and calls undo() for the same key. Both fire for every Cmd+Z when a TipTap editor is focused. The stopPropagation() in ProseMirror's handleKeyDown only stops bubble-phase propagation, not the already-fired capture-phase handler in App.tsx. Result: each Cmd+Z invokes two undo IPC calls — consuming two undo steps when there's enough history, or consuming one and silently no-opping the second.

fix: not applied (diagnose-only mode)
verification: not performed
files_changed: []
