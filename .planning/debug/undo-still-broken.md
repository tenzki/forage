---
status: fixing
trigger: "Cmd+Z undo STILL doesn't work after previous fix attempt — both structural and text undo fail"
created: 2026-03-25T00:00:00Z
updated: 2026-03-25T00:00:00Z
---

## Current Focus

hypothesis: Multiple distinct bugs found via code reading — catalogued below
test: Static analysis of all five relevant files complete
expecting: Root cause(s) identified
next_action: Document and present findings

## Symptoms

expected: Cmd+Z undoes the last node creation/deletion (test 3) and the last text edit (test 4)
actual: Nothing happens — both structural undo and text undo fail
errors: No reported JS errors (silent failures likely)
reproduction: Type in any node, press Cmd+Z — content unchanged. Create a node, press Cmd+Z — node stays.
started: After previous fix attempt (03-05)

## Eliminated

- hypothesis: App.tsx does NOT call the store undo()
  evidence: App.tsx line 39 calls `undo().catch(console.error)` correctly in a capture-phase listener
  timestamp: 2026-03-25

- hypothesis: Mod-z handled in OutlinerKeys causing double-fire
  evidence: NodeEditor.tsx OutlinerKeys has no Mod-z/Mod-Shift-z binding (line 146 comment confirms intentional removal)
  timestamp: 2026-03-25

- hypothesis: StarterKit ProseMirror history not disabled
  evidence: NodeEditor.tsx line 197 has `undoRedo: false` in StarterKit.configure
  timestamp: 2026-03-25

- hypothesis: store.undo() method does not exist
  evidence: treeStore.ts lines 785-820 defines undo() correctly
  timestamp: 2026-03-25

- hypothesis: undoStepIpc/recordUndoStepIpc not exported from ipc.ts
  evidence: Both are exported and use correct invoke('undo_step', {}) and invoke('record_undo_step', {...})
  timestamp: 2026-03-25

- hypothesis: Rust commands not registered in lib.rs
  evidence: lib.rs lines 25-27 register record_undo_step, undo_step, redo_step
  timestamp: 2026-03-25

## Evidence

- timestamp: 2026-03-25
  checked: NodeEditor.tsx — handleKeyDown stopPropagation
  found: editorProps.handleKeyDown (line 302-311) calls event.stopPropagation() on ALL key events, then returns undefined (not true). This does NOT prevent the capture-phase listener in App.tsx from firing (capture-phase fires BEFORE the target's handlers) but confirms TipTap processes the event first.
  implication: Capture phase in App.tsx fires BEFORE TipTap's stopPropagation. So App.tsx does receive Cmd+Z. This path is NOT broken.

- timestamp: 2026-03-25
  checked: treeStore.ts undo() lines 785-820
  found: undo() calls undoTracker.flush(), then awaits recordUndoStepIpc(...), then awaits undoStepIpc(). If undoStepIpc returns {node_ids: [...], operation: ...}, it calls loadTree(). If result.node_ids.length === 0, it does NOT reload the tree.
  implication: If undo_step returns a result with empty node_ids, the UI never refreshes. But more critically...

- timestamp: 2026-03-25
  checked: undo_history table schema (migration 0002)
  found: undo_history.node_id has a FOREIGN KEY REFERENCES nodes(id) ON DELETE CASCADE constraint. This means: when a node is deleted (e.g., undo a 'create'), the undo_history entry for that node is CASCADE-deleted too.
  implication: The undo.rs code works around this for 'create' operations by re-inserting the history entry with FK off. This seems handled.

- timestamp: 2026-03-25
  checked: treeStore.ts createNode() lines 399-401 — recordUndoStepIpc call
  found: recordUndoStepIpc is called AFTER the IPC createNodeIpc() succeeds. Uses .catch() so it's fire-and-forget. The call is CORRECT and will record undo steps.
  implication: Structural undo recording path looks correct.

- timestamp: 2026-03-25
  checked: treeStore.ts updateContent() undo grouping logic (lines 453-505)
  found: BUG #1 — shouldStartNewGroup() returns true on the VERY FIRST keystroke (undoGroupKey === null check, line 27 of undoGrouping.ts). When true, it calls flush() which returns null (nothing to flush yet), then calls startGroup(). On subsequent keystrokes within 1000ms, shouldStartNewGroup() returns false and touch() is called. The group is never explicitly recorded — it only gets recorded when ANOTHER group starts OR when undo() is called and flushes the pending group.
  implication: Text edits ARE being tracked, but the group only gets recorded as an undo step when (a) a new group starts, or (b) undo() is called. This means if you type, then immediately press Cmd+Z, the pending group is flushed and recorded in undo(). This should work.

- timestamp: 2026-03-25
  checked: treeStore.ts updateContent() lines 462-470 — flush logic
  found: BUG #2 (CRITICAL) — When a NEW group starts (because >1000ms elapsed or node changed), the code calls recordUndoStepIpc with the CURRENT content as after_json BUT the current content is the new keystroke's content, not the end of the PREVIOUS group's content. Look at line 469: `JSON.stringify(content)` — `content` here is the parameter to updateContent(), which is the LATEST content being typed. However, this is the content for the NEW group's first character, not the snapshot at the end of the OLD group. The after_json for the old group should be the content at the time the old group's last keystroke occurred, but we have no separate tracking for that.
  implication: The text edit undo snapshots have wrong after_json (off by one keystroke), but this wouldn't prevent undo from working entirely — it would just undo to a slightly wrong point.

- timestamp: 2026-03-25
  checked: App.tsx Cmd+Z handler — closure freshness
  found: BUG #3 (CRITICAL) — App.tsx lines 11-12 get undo and redo via useTreeStore selector hooks: `const undo = useTreeStore((s) => s.undo)`. These are stable function references since they're defined in the store (Zustand). The useEffect at line 23 has `[undo, redo]` in its dependency array, so the listener re-registers when undo/redo change. Since Zustand store functions are stable references, this should be fine. NOT a bug.
  implication: Closure freshness is not the issue.

- timestamp: 2026-03-25
  checked: ipc.ts undoStepIpc() — invoke call
  found: Line 158: `await invoke<UndoResult | null>('undo_step', {})`. The second argument is `{}` — an empty object. In Tauri v2, when invoking a command with NO arguments, the empty object `{}` should work correctly. The Rust command signature is `pub async fn undo_step(state: State<'_, AppState>)` with only AppState — no other parameters needed from the frontend.
  implication: This looks correct. BUT worth verifying — Tauri v2 invoke with `{}` vs no args.

- timestamp: 2026-03-25
  checked: undo.rs record_undo_step — parameter casing
  found: BUG #4 (CRITICAL) — The Rust command uses snake_case parameter names: `node_id`, `before_json`, `after_json`, `group_key`. In Tauri v2, invoke parameters are automatically converted from camelCase in JS to snake_case in Rust. ipc.ts line 141-146 passes: `{ operation, nodeId, beforeJson, afterJson, groupKey: groupKey ?? null }`. These are camelCase. Tauri v2 DOES perform automatic camelCase→snake_case conversion, so `nodeId` → `node_id`, etc. This should be fine.
  implication: Parameter naming is not the bug.

- timestamp: 2026-03-25
  checked: undo.rs — undo_step pointer logic when position=0 after group undo
  found: After undoing, new_position = min_id - 1. If there was only one entry (id=1), new_position = 0. Next call to undo_step reads position=0, returns Ok(None) — correct.
  implication: Pointer logic is correct.

- timestamp: 2026-03-25
  checked: THE REAL BUG — App.tsx capture-phase handler prevents TipTap from receiving the event
  found: BUG #5 (CRITICAL — THE ROOT CAUSE FOR TEXT UNDO): App.tsx line 38 calls e.preventDefault() for Cmd+Z. This prevents the browser default (which ProseMirror/TipTap has no role in since undoRedo: false). BUT more importantly — the capture-phase handler fires BEFORE TipTap's own keydown handler. TipTap processes keyboard shortcuts via its own keydown handler AFTER capture phase. Since undoRedo: false is set, TipTap won't handle Cmd+Z anyway. So this is fine.
  implication: The capture-phase preventDefault doesn't block anything important here.

- timestamp: 2026-03-25
  checked: THE ACTUAL ROOT CAUSE — updateContent() calls recordUndoStepIpc in wrong order
  found: BUG #6 (ROOT CAUSE FOR TEXT UNDO): In updateContent(), when shouldStartNewGroup() returns true, the code FIRST records the old group, THEN calls startGroup() with a snapshot from get().nodes (line 475-477). BUT the snapshot is taken from the LOCAL STORE STATE which has ALREADY been updated optimistically (well — no, the set() call happens AFTER on line 484). Actually wait — let me re-read...

  Line 458: shouldStartNewGroup check
  Lines 460-471: flush old group, record it via recordUndoStepIpc (fire-and-forget with .catch)
  Lines 475-477: startGroup with currentNode snapshot from get().nodes
  Line 484: set() — optimistic update

  So startGroup captures the node BEFORE the optimistic set(). That's correct — the snapshot represents the state before the current edit group begins.

  But the REAL issue: on the VERY FIRST keystroke to a node, shouldStartNewGroup returns true (undoGroupKey === null). flush() returns null. startGroup() is called. No undo step is recorded yet. Good.

  On the SECOND+ keystroke within 1000ms, shouldStartNewGroup returns false. touch() is called. No undo step recorded. Good — it's accumulating.

  When Cmd+Z is pressed: undo() flushes the pending group and records it THEN calls undoStepIpc(). But wait — recordUndoStepIpc is ASYNC. undo() does `await recordUndoStepIpc(...)`. Then `await undoStepIpc()`. So recordUndoStepIpc completes before undoStepIpc is called. The step IS recorded before undo runs.

  HOWEVER: What if the user types and the 300ms debounce for updateNodeIpc() hasn't fired yet? The undo step is recorded with the in-memory content, but the DB hasn't been updated yet. The undo_step applies before_json from the snapshot. The snapshot was the state BEFORE the group started. After undo_step applies the snapshot, loadTree() is called, which reloads from DB. But the DB still has the... wait.

  CRITICAL FINDING: The before_json snapshot in the undo step has the content from before the group started. undo_step applies this via INSERT OR REPLACE. Then loadTree() reads from DB. The DB now has the before_json content. BUT the 300ms debounce for updateNodeIpc() may still be pending and fire AFTER the undo! When it fires, it writes the CURRENT (new) content back to the DB, overwriting the just-restored snapshot.
  implication: The debounce timer races with the undo operation. After undo restores old content, the still-pending debounce timer fires and re-writes the new content to DB, making undo appear to not work.

- timestamp: 2026-03-25
  checked: updateDebounceTimers management — is the timer cancelled on undo?
  found: BUG #7 (ROOT CAUSE CONFIRMED for text undo): undo() in treeStore.ts (lines 785-820) does NOT cancel any pending debounce timers in updateDebounceTimers. The Map stores pending setTimeout handles keyed by node ID. When the user types and then presses Cmd+Z before 300ms elapses, the undo() runs: it records the step, calls undoStepIpc() which restores the old content in DB, calls loadTree() which updates the React state to the old content. Then ~300ms later, the pending setTimeout fires and calls updateNodeIpc(id, newContent, ...) — writing the NEW (post-typing) content back to the DB and the tree gets updated with new content again. Undo appears to silently fail.
  implication: THIS IS THE ROOT CAUSE for text undo failure.

- timestamp: 2026-03-25
  checked: Structural undo (createNode, deleteNode) — why does test 3 fail?
  found: createNode records undo step correctly. deleteNode records undo step correctly. The undo_history table has a FK constraint on node_id. When undoing a 'create', the undo.rs deletes the node and re-inserts the history entry with FK off. This logic looks correct. BUT...

  SECOND ROOT CAUSE for structural undo: After createNode succeeds, recordUndoStepIpc is called fire-and-forget with .catch(). The store's undo() function flushes the undoTracker (text edit tracker). If no text was typed, undoTracker.flush() returns null, and undo() proceeds directly to undoStepIpc().

  WAIT — but is there a TIMING issue? createNode calls recordUndoStepIpc as fire-and-forget (not awaited). If the user presses Cmd+Z immediately after creating a node, undoStepIpc() may run BEFORE recordUndoStepIpc() completes. Result: undo_step finds an empty history (position=0) and returns null. The undo silently does nothing.
  implication: Fire-and-forget recordUndoStepIpc in createNode/deleteNode/indentNode/outdentNode creates a race condition with undo(). If user presses Cmd+Z quickly, the step isn't recorded yet.

## Resolution

root_cause: |
  TWO distinct root causes found:

  ROOT CAUSE 1 — Text undo (test 4):
  The updateContent() debounce timer (300ms) is not cancelled when undo() runs.
  Flow: user types → debounce timer starts → user presses Cmd+Z within 300ms →
  undo() records pending group, calls undoStepIpc() (restores old content in DB), calls loadTree() (React state updated to old content) → ~300ms later debounce fires → updateNodeIpc() writes NEW content back to DB → loadTree() is NOT called again → DB has new content but React might show old content briefly, OR next interaction triggers a reload showing the re-written new content.

  ROOT CAUSE 2 — Structural undo (test 3):
  recordUndoStepIpc() is called fire-and-forget (not awaited) in createNode/deleteNode/indentNode/outdentNode/reorderNode. If the user presses Cmd+Z before the fire-and-forget IPC call completes, undoStepIpc() runs against an un-populated undo_history (position=0 or wrong position) and returns null with no undo performed.

fix: |
  Fix 1 (APPLIED): In undo(), cancel all pending debounce timers before calling undoStepIpc().
  Added at start of undo(): clear all updateDebounceTimers entries via clearTimeout + .clear().
  This prevents the 300ms debounce from re-writing new content after undo restores old state.

  Fix 2 (APPLIED): In createNode/deleteNode/indentNode/outdentNode/reorderNode, changed
  fire-and-forget recordUndoStepIpc(...).catch(...) calls to awaited calls.
  This ensures undo steps are persisted in DB before any Cmd+Z can run.

verification: awaiting human verification
files_changed:
  - src/store/treeStore.ts
