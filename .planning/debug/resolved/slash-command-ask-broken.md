---
status: resolved
trigger: "Typing /ask in the editor and selecting it from the slash command popup doesn't do anything"
created: 2026-03-29T00:00:00Z
updated: 2026-03-29T00:00:00Z
symptoms_prefilled: true
goal: find_and_fix
---

## Current Focus

hypothesis: CONFIRMED — OutlinerKeys Enter/ArrowUp/ArrowDown always return true, consuming events before SlashCommand suggestion plugin onKeyDown fires
test: Fix applied — added isSlashSuggestionActive flag exported from SlashCommand.tsx, set in onStart/onUpdate, cleared in onExit; OutlinerKeys checks flag before handling Enter/ArrowUp/ArrowDown
expecting: With flag guards in place, keyboard selection and navigation in slash popup works correctly
next_action: human verification

## Symptoms

expected: Typing /ask and pressing Enter (or clicking item) invokes agentStore.invokeSkill, creating a ghost child node and streaming an AI response
actual: Nothing happens — no node created, no IPC call, no errors visible
errors: none reported
reproduction: Type /ask in any editor node, see popup appear, press Enter or click item — nothing happens
started: Investigating now

## Eliminated

- hypothesis: SlashCommand.configure onSkillInvoked not wired
  evidence: NodeEditor.tsx line 217-219 wires SlashCommand.configure({ onSkillInvoked }) correctly calling useAgentStore.getState().invokeSkill
  timestamp: 2026-03-29

- hypothesis: agentStore.invokeSkill not implemented
  evidence: agentStore.ts lines 275-342 implements invokeSkill fully — builds context, creates ghost node, sends IPC
  timestamp: 2026-03-29

- hypothesis: IPC agentCommandIpc not wired
  evidence: ipc.ts line 268-270 implements agentCommandIpc via invoke('agent_command') correctly
  timestamp: 2026-03-29

- hypothesis: sidecar prompt handler missing
  evidence: src-sidecar/index.ts lines 288-290 handles 'prompt' command via handlePrompt()
  timestamp: 2026-03-29

- hypothesis: ask skill missing
  evidence: src-sidecar/skills/ask.ts exports askSkill with systemPrompt; registered in SKILLS map at line 41
  timestamp: 2026-03-29

- hypothesis: SlashCommand extension command handler broken
  evidence: SlashCommand.tsx lines 240-258 correctly deletes range and calls onSkillInvoked
  timestamp: 2026-03-29

## Evidence

- timestamp: 2026-03-29
  checked: OutlinerKeys Enter handler — NodeEditor.tsx lines 66-69
  found: Enter handler always returns true (consumed), regardless of whether slash popup is active
  implication: TipTap processes keyboard shortcuts in extension registration order. OutlinerKeys is registered AFTER SlashCommand in the extensions array (lines 200-293), but ProseMirror keyboard shortcuts from extensions run in REVERSE registration order (last registered = highest priority). OutlinerKeys is registered last, so it has HIGHEST priority. Its Enter: () => true always consumes the Enter key before the Suggestion plugin's onKeyDown can fire.

- timestamp: 2026-03-29
  checked: TipTap extension array order in NodeEditor.tsx lines 200-293
  found: [StarterKit, HashtagNode, SlashCommand, OutlinerKeys] — OutlinerKeys is last
  implication: ProseMirror handles keydown via plugin priority — plugins added last have highest priority in keydown handling. OutlinerKeys.addKeyboardShortcuts() Enter handler fires before SlashCommand's Suggestion plugin onKeyDown, consuming the event.

- timestamp: 2026-03-29
  checked: SlashCommand.tsx onKeyDown handler lines 291-303
  found: The render().onKeyDown only fires if TipTap's Suggestion plugin's own keydown is reached. Since OutlinerKeys.Enter returns true (consumed) first, the Suggestion plugin never gets the Enter keydown event.
  implication: This is the root cause for keyboard selection. Mouse click via onMouseDown (line 140) should work independently since it bypasses keydown entirely.

- timestamp: 2026-03-29
  checked: SlashSuggestionPopup mouse handler — SlashCommand.tsx line 140-143
  found: onMouseDown calls e.preventDefault() then selectItem(). selectItem calls command(skill). The command prop is (skill) => currentCommand?.(skill). currentCommand is set in onStart/onUpdate to props.command. This chain should work for mouse clicks.
  implication: Mouse clicks should invoke the skill. Keyboard Enter does NOT work because OutlinerKeys consumes it. However since the popup is rendered via a React root outside TipTap, the mouse click path should work. But the user reports "doesn't do anything" suggesting even mouse clicks fail OR they're only using keyboard.

- timestamp: 2026-03-29
  checked: ArrowUp/ArrowDown handling — OutlinerKeys lines 129-136
  found: ArrowUp calls opts.onFocusPrev() and returns true. ArrowDown calls opts.onFocusNext() and returns true. Both always consume arrow keys.
  implication: Arrow key navigation in the popup also broken — OutlinerKeys handles ArrowUp/Down before SlashCommand suggestion plugin can.

## Resolution

root_cause: |
  OutlinerKeys extension is registered last in NodeEditor's extensions array, giving it
  highest priority in ProseMirror's keydown handling. Its Enter, ArrowUp, and ArrowDown
  handlers always return true (consuming the event), preventing the SlashCommand
  Suggestion plugin's onKeyDown from ever firing.

  Specifically:
  - Enter: OutlinerKeys always handles Enter (calls createNode), so popup Enter-to-select never fires
  - ArrowUp/Down: OutlinerKeys always handles arrows (calls focusPrev/Next), so popup navigation never fires

  Fix: The OutlinerKeys Enter, ArrowUp, and ArrowDown handlers must check whether the
  slash suggestion popup is active before consuming the event. When the popup is active,
  they should return false (not handled) so the Suggestion plugin's onKeyDown can process
  the event.

fix: |
  In OutlinerKeys keyboard shortcuts, guard Enter, ArrowUp, and ArrowDown:
  - Only handle them when no slash suggestion is active
  - Detect active suggestion via a shared flag or by checking DOM state

  Best approach: Export a mutable ref from SlashCommand or use a module-level flag
  that is set true when suggestion popup is open (onStart/onUpdate) and false on
  onExit. OutlinerKeys checks this flag before handling Enter/ArrowUp/ArrowDown.

verification: fix applied — awaiting human verification
files_changed:
  - src/extensions/SlashCommand.tsx
  - src/components/Outliner/NodeEditor.tsx
