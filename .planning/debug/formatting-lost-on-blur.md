---
status: diagnosed
trigger: "bold/italic/code formatting is lost when a node loses focus"
created: 2026-03-25T00:00:00Z
updated: 2026-03-25T00:00:00Z
---

## Current Focus

hypothesis: Non-editing nodes render node.name (plain text) instead of the ProseMirror JSON with marks
test: Read NodeRow.tsx, NodeEditor.tsx, tree.ts, treeStore.ts
expecting: NodeRow renders node.data.name (plain text) for non-editing nodes — CONFIRMED
next_action: ROOT CAUSE FOUND — no fix applied (goal: find_root_cause_only)

## Symptoms

expected: Bold/italic/code formatting applied in TipTap editor persists visually after clicking away
actual: Formatting is visible while editing; when focus leaves the node it reverts to plain unstyled text
errors: No errors — silent visual regression
reproduction: Apply bold/italic/code to any text in a node, click elsewhere
started: By design in current implementation (single active editor pattern)

## Eliminated

- hypothesis: Content (ProseMirror JSON with marks) is not being saved to the store
  evidence: updateContent (treeStore.ts:453) does `set({ nodes: updateNodeInTree(..., { name: text, content }) })` — both name AND content are updated in the store. The full JSON including marks is preserved in node.content.
  timestamp: 2026-03-25

- hypothesis: extractText strips marks before storing content
  evidence: extractText (tree.ts:16) is only used to derive node.name (plain text label). node.content is stored separately and is the full ProseMirror JSON including all marks. The content is NOT stripped.
  timestamp: 2026-03-25

## Evidence

- timestamp: 2026-03-25
  checked: NodeRow.tsx lines 100-109
  found: >
    The conditional renders either NodeEditor (when isEditing) or a plain <span>{node.data.name}</span>.
    node.data.name is the plain-text string populated by extractText() — it contains zero mark information.
  implication: When editingNodeId !== node.data.id, the node renders its name field (plain text), discarding all formatting.

- timestamp: 2026-03-25
  checked: tree.ts extractText (lines 16-41)
  found: >
    extractText walks the ProseMirror doc tree and concatenates only nodes where type === 'text', pulling
    the raw `text` string. It never reads the `marks` array on inline nodes. Result is always a plain string.
  implication: node.name is always unformatted. Any node rendered via node.name loses bold/italic/code.

- timestamp: 2026-03-25
  checked: treeStore.ts updateContent (lines 453-506)
  found: >
    On every TipTap onUpdate event, both `name` (extractText output) and `content` (full ProseMirror JSON)
    are written into the store node. So node.content in the store always holds the full rich JSON including marks.
  implication: The data is not lost — it is stored correctly. The bug is purely in the render path for non-editing nodes.

- timestamp: 2026-03-25
  checked: NodeEditor.tsx onBlur (lines 293-296)
  found: >
    onBlur calls clearSelection() then setEditingNode(null), which sets editingNodeId to null in the store.
    This causes NodeRow to re-render and switch from NodeEditor to the plain <span>.
  implication: The moment editingNodeId becomes null, all marks disappear because the plain-text span is shown.

- timestamp: 2026-03-25
  checked: NodeEditor.tsx content initialisation (line 289)
  found: content: node.content as object — TipTap is initialised with the full ProseMirror JSON, so marks are loaded correctly when a node is opened for editing.
  implication: Editing experience is correct; only the read-only view is broken.

## Resolution

root_cause: >
  NodeRow.tsx renders non-editing nodes as a plain <span>{node.data.name}</span> where node.data.name is
  derived from extractText() — a pure plain-text extraction that discards all ProseMirror marks (bold,
  italic, code, etc.).

  The full rich content (with marks) is available at node.data.content and is correctly stored in the
  Zustand store, but NodeRow never uses it for the read-only display.

  This means: as soon as a node loses focus (onBlur → setEditingNode(null) → NodeEditor unmounts →
  plain <span> renders), all formatting disappears, even though the data is intact.

fix: NOT APPLIED (goal: find_root_cause_only)

suggested_fix_direction: >
  Replace the plain <span> in NodeRow with a read-only TipTap EditorContent (or a lightweight
  ProseMirror HTML renderer) that reads from node.data.content. A lighter-weight alternative is
  to render the ProseMirror JSON to HTML (using generateHTML from @tiptap/core) and set it via
  dangerouslySetInnerHTML, avoiding the cost of a full editor instance for every non-editing node.

files_changed: []
