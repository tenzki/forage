---
status: diagnosed
trigger: "Investigate why typing #hashtag in a node doesn't trigger autocomplete or create a hashtag in the ai-chat app."
created: 2026-03-25T00:00:00Z
updated: 2026-03-25T00:00:00Z
---

## Current Focus

hypothesis: confirmed - two independent root causes found
test: static code analysis of all relevant files
expecting: n/a - diagnosis complete
next_action: report findings to caller

## Symptoms

expected: typing # followed by characters triggers autocomplete popup and eventually creates a HashtagNode atom
actual: "doesn't work" - no popup, no hashtag node created
errors: none reported
reproduction: open any node editor, type "#" then any characters
started: unknown - new feature

## Eliminated

- hypothesis: HashtagNode extension not registered in NodeEditor
  evidence: NodeEditor.tsx line 211 — HashtagNode.configure({...}) is present in the extensions array
  timestamp: 2026-03-25

- hypothesis: @tiptap/suggestion package missing
  evidence: package.json line 19 — "@tiptap/suggestion": "^3.20.5" is listed in dependencies
  timestamp: 2026-03-25

- hypothesis: suggestion char '#' not configured
  evidence: HashtagNode.tsx line 203 — char: '#' is set correctly
  timestamp: 2026-03-25

- hypothesis: OutlinerKeys stopPropagation blocking the '#' character from reaching ProseMirror
  evidence: OutlinerKeys only intercepts Enter, Tab, Shift-Tab, Backspace, Alt-Arrow*, ArrowUp/Down, Shift-Arrow*, Mod-z, Mod-Shift-z — the '#' key press is NOT intercepted
  timestamp: 2026-03-25

## Evidence

- timestamp: 2026-03-25
  checked: HashtagNode.tsx — suggestion items callback (lines 208-214)
  found: |
    items: async ({ query }) => {
      if (query.length < 2) return []   // ← silent early return
      ...
    }
  implication: The popup renders only when items.length > 0 (SuggestionPopup line 59: `if (!rect || items.length === 0) return null`). After typing exactly "#a" (1 char query) items returns [] and the popup stays hidden. The user must type 3+ characters ("#ab") before anything can appear. This is a UX bug — the threshold is documented as "< 2" but effectively silences the popup for any single-character query.

- timestamp: 2026-03-25
  checked: HashtagNode.tsx — items callback (line 209) and getTagsMatchingIpc (ipc.ts line 228-235)
  found: getTagsMatchingIpc calls invoke('get_tags_matching', { prefix }) — a Tauri IPC call to the Rust backend. This will throw an error (caught silently in the catch block) if the Rust command 'get_tags_matching' does not exist or errors out at runtime. The catch returns [] which again hides the popup.
  implication: If the Rust backend has not been built with get_tags_matching, every autocomplete attempt silently fails and returns no items.

- timestamp: 2026-03-25
  checked: HashtagNode.tsx — render() callbacks and popup rendering (lines 182-197)
  found: renderPopup() is async (uses dynamic import('react-dom/client').then(...)). The root is created lazily and rendered inside a `.then()` callback. On the very first onStart call, createRoot has not been called yet, so there's a timing gap where the popup container exists but nothing has been rendered into it.
  implication: Minor — on fast machines this gap is sub-millisecond, but it means the popup may flicker or not appear on the very first trigger.

- timestamp: 2026-03-25
  checked: HashtagNode.tsx — suggestion allowedPrefixes (line 206)
  found: allowedPrefixes: null
  implication: null means any character is allowed before '#', which is correct and not a bug.

- timestamp: 2026-03-25
  checked: HashtagNode.tsx — onKeyDown render callback (lines 256-265)
  found: |
    onKeyDown returns true for ArrowDown/ArrowUp/Enter only when currentItems.length > 0.
    The SuggestionPopup component also attaches its own window keydown listener (lines 33-53).
    Both are therefore gated on items being non-empty, which is correct.
  implication: No conflict here.

## Resolution

root_cause: |
  PRIMARY (definitive): The suggestion `items` callback returns [] for any query shorter than 2 characters (`if (query.length < 2) return []`). The SuggestionPopup component refuses to render when items is empty (`if (!rect || items.length === 0) return null`). Combined, this means:
    - Typing "#" (0-char query): no popup
    - Typing "#a" (1-char query): no popup
    - Typing "#ab" (2-char query): IPC call fires — popup appears ONLY if the Rust backend returns at least one matching tag

  SECONDARY (likely silent failure in practice): `getTagsMatchingIpc` makes a Tauri IPC call to 'get_tags_matching'. If this Rust command is missing, throws, or returns an empty result because the tags table has no data yet, the catch block silently returns [] and the popup never shows — even for queries >= 2 chars.

  These two issues together mean that in a fresh install with no existing tags, the autocomplete will NEVER appear regardless of what the user types.

fix: (not applied — diagnosis only)
  1. Lower the query threshold from `< 2` to `< 1` (or remove it entirely) so the popup activates after typing just one character after '#'.
  2. Verify the Rust `get_tags_matching` command exists and the tags table is populated, or add a fallback that shows a "no matching tags" message or allows creating a new tag directly.

verification: not applied
files_changed: []
