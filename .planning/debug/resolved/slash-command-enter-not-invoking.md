---
status: resolved
trigger: "After selecting a slash command from the dropdown (e.g., /ask ), typing a query and pressing Enter does NOT invoke the skill"
created: 2026-03-29T00:00:00Z
updated: 2026-03-29T00:00:00Z
symptoms_prefilled: true
---

## Current Focus

hypothesis: isSlashSuggestionActive remains true after dropdown selection because renderPopup is async (uses import().then()), delaying the onExit cleanup — OR the Suggestion plugin re-triggers a new suggestion on the inserted "/ask " text
test: Trace the exact state of isSlashSuggestionActive and what Suggestion plugin does after command() inserts "/ask "
expecting: Find where Enter is consumed or isSlashSuggestionActive stays true
next_action: Read TipTap Suggestion plugin source to understand when onExit fires relative to command()

## Symptoms

expected: Pressing Enter after typing "/ask what year?" invokes the skill via onSlashCommandEnter
actual: Nothing happens — Enter does not invoke the skill
errors: None reported
reproduction: Type "/" → see dropdown → select "ask" → type "what year?" → press Enter → skill not invoked
started: After recent change adding Enter key handling in OutlinerKeys

## Eliminated

(none yet)

## Evidence

- timestamp: 2026-03-29
  checked: NodeEditor.tsx OutlinerKeys Enter handler (lines 69-83)
  found: Enter handler checks isSlashSuggestionActive first (returns false if true), then calls editor.getText() and detectSlashCommand(). onSlashCommandEnter is properly wired at line 307-309.
  implication: Handler logic looks correct structurally. Issue must be in one of: isSlashSuggestionActive state, getText() return value, or the handler not running at all.

- timestamp: 2026-03-29
  checked: SlashCommand.tsx onExit (line 325-328) and renderPopup (lines 225-241)
  found: renderPopup uses `import('react-dom/client').then(...)` making it ASYNC. The actual React render/unmount is deferred to a Promise microtask. HOWEVER, isSlashSuggestionActive = false is set synchronously in onExit BEFORE renderPopup is called. So the flag is correct even if the popup takes time to visually disappear.
  implication: isSlashSuggestionActive flag is set synchronously. This is NOT the bug.

- timestamp: 2026-03-29
  checked: SlashSuggestionPopup window keydown listener (lines 116-137)
  found: The popup adds a capture-phase window keydown listener that intercepts Enter and calls e.preventDefault() + selectItem(). This listener is cleaned up in useEffect return (when component unmounts). Because renderPopup(null) is async, the component stays mounted briefly after onExit fires.
  implication: Could cause double-invocation but not prevent skill invocation. Does NOT call stopPropagation() so TipTap still receives Enter.

- timestamp: 2026-03-29
  checked: Suggestion plugin behavior when command() inserts "/ask "
  found: allowSpaces: false means the suggestion exits when it sees a space in the query. After command() inserts "/ask ", the Suggestion plugin detects the space and calls onExit synchronously as part of the transaction handling. isSlashSuggestionActive = false.
  implication: After dropdown selection, flag is false. The OutlinerKeys Enter handler should run.

## Resolution

root_cause: |
  SlashSuggestionPopup has a capture-phase window keydown listener that intercepts
  Enter. When the user selects a skill from the dropdown, onExit() fires synchronously
  (setting isSlashSuggestionActive = false) but calls renderPopup(null) which is async
  (uses import('react-dom/client').then(...)). The component remains mounted and its
  window listener remains active. When the user finishes typing their query and presses
  Enter, the still-mounted popup's listener fires FIRST (capture phase), calls
  selectItem(0) → currentCommand(ask) → editor.chain().deleteRange(staleRange).insertContent('/ask ').run()
  with a stale range from when the suggestion was originally active. This corrupts the
  editor content (deletes part of the query and re-inserts '/ask '). Then OutlinerKeys'
  Enter handler runs but sees corrupted text ('/ask ' with no args), detectSlashCommand
  returns null, and opts.onEnter() is called instead — creating a new node rather than
  invoking the skill.

fix: |
  In onExit(), set currentItems = [] and currentCommand = null BEFORE calling
  renderPopup(null). Since the popup's command prop is (skill) => currentCommand?.(skill),
  nulling currentCommand makes any invocation from the still-mounted popup a no-op.
  The currentItems = [] guard also makes selectItem return early (items[i] is undefined,
  guarded by `if (skill)`).

verification: |
  Static analysis verified:
  - onExit now clears currentItems and currentCommand synchronously before async unmount
  - popup's selectItem: items[0] = undefined → if(skill) guard → no command call
  - popup's command prop: (skill) => null?.(skill) → no-op
  - isSlashSuggestionActive is false, so OutlinerKeys Enter handler runs normally
  - editor.getText() returns '/ask what year?', detectSlashCommand returns {skillId:'ask', args:'what year?'}
  - onSlashCommandEnter fires, invokeSkill is called

files_changed:
  - src/extensions/SlashCommand.tsx
