# Phase 2: Core Outliner - Research

**Researched:** 2026-03-24
**Domain:** React tree UI with keyboard-driven outliner UX, virtualization, drag-and-drop, Tauri v2 IPC integration
**Confidence:** HIGH (core React and react-arborist verified via official sources; Tauri/React integration confirmed via official docs; keyboard interaction patterns verified via multiple sources)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Visual Feel**
- Workflowy-minimal aesthetic — white background, tiny chrome, content is everything
- Light theme only for v1 (no dark mode)
- System font (San Francisco on macOS) — native feel, no web font loading
- Small filled circle bullets (Workflowy-style) — dot toggles expand/collapse
- Minimal spacing, high content density

**Keyboard Behavior**
- Exact Workflowy keyboard bindings:
  - Enter = new sibling below (regardless of whether current node has children)
  - Tab = indent (nest under previous sibling)
  - Shift+Tab = outdent (move to parent's level)
  - Alt+Up/Down = reorder among siblings
  - Alt+Left = outdent (same as Shift+Tab via keyboard move)
  - Alt+Right = nest under previous sibling (same as Tab via keyboard move)
  - Delete/Backspace on empty node = delete node, cursor moves to previous node's end
- Shift+Arrow selects range of nodes for batch move/indent/delete
- Alt+Arrow provides full move capability (reorder + re-nest across parents)

**Zoom/Hoist UX**
- Click bullet to zoom into node (node becomes root view)
- Clickable breadcrumb trail at top: Home > Parent > Current — each segment navigates back
- Subtle 150ms crossfade transition on zoom
- Window title reflects current zoomed node text

**Drag-and-Drop**
- Full drag capability: reorder siblings, re-nest under new parent, move across depth levels
- Drop indicator: line between nodes for reorder, highlight on target for nesting (context-dependent)
- Entire subtree moves together when dragging a node with children
- Mouse drag and keyboard (Alt+Arrow) provide equivalent move capabilities

**Content Format (from Phase 1)**
- Rich text (TipTap/ProseMirror JSON) is the content format — basic text editing in this phase (inline Markdown rendering deferred to Phase 3)

### Claude's Discretion
- React tree component choice (react-arborist vs custom)
- CSS approach (Tailwind, CSS modules, etc.)
- State management pattern (React context, Zustand, etc.)
- Virtualization strategy for large trees
- Exact animation easing and timing
- Empty state design (first launch)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TREE-01 | User can create infinite nested bullet-point nodes | react-arborist provides virtualized infinite depth; IPC `create_node` + `get_children` pattern established in Phase 1; fractional-indexing already installed for position management |
| TREE-02 | User can expand and collapse any branch | react-arborist provides `onToggle` callback and `collapsed` node state; `update_node(collapsed: bool)` IPC command persists to SQLite; `openByDefault` and controlled open state via `data` prop |
| TREE-03 | User can zoom/hoist into any node (node becomes root view with breadcrumb trail) | React state for `zoomedNodeId`; re-fetch tree from that node ID as root; breadcrumb built by walking parent chain via IPC `get_node` calls; CSS opacity transition for crossfade |
| TREE-04 | User can navigate and edit entirely via keyboard (Tab, Shift-Tab, Enter, Alt+Arrow, Delete) | TipTap `addKeyboardShortcuts` intercepts Enter/Tab/Backspace; react-arborist `renderRow` onKeyDown intercepts Alt+Arrow; all structural ops via IPC; focus management via tree ref |
| TREE-06 | User can drag nodes to reorder or re-nest them | react-arborist built-in drag-and-drop via `onMove` callback; `disableDrop` function for fine-grained control; fractional-indexing for recalculating positions on drop |
</phase_requirements>

---

## Summary

Phase 2 builds the frontend outliner UI on top of the Tauri v2 IPC layer established in Phase 1. The primary work is: (1) adding React to the project (currently vanilla TS), (2) implementing the tree view using react-arborist 3.4.x as the rendering/interaction layer, (3) writing a Zustand store that bridges IPC calls to tree state, (4) integrating TipTap as the per-node content editor with customized keyboard shortcuts, and (5) implementing zoom/hoist and the breadcrumb navigation UI.

The key architectural insight: react-arborist expects **nested** data (`{ id, children: [...] }`), but the Phase 1 backend returns flat adjacency-list rows via `get_children(parent_id)`. A hydration step must convert the flat IPC responses into the nested tree shape react-arborist consumes, and conversely the `onMove`/`onCreate`/`onDelete` callbacks must call the IPC commands. This adapter layer is the most critical code to get right.

The keyboard contract (Tab/Shift-Tab/Enter/Alt+Arrow) requires intercepting keys at two levels: TipTap intercepts Enter (prevent new paragraph, create sibling node) and Tab/Shift-Tab (prevent focus loss, indent/outdent current node). The parent row intercepts Alt+Up/Down/Left/Right for structural moves. react-arborist's built-in keyboard shortcuts handle arrow navigation and Delete — the custom keys must use `stopPropagation` or the row-level `onKeyDown` override to coexist cleanly.

**Primary recommendation:** Use react-arborist 3.4.3 in controlled mode (`data` prop) with a Zustand store holding the hydrated nested tree. Use TipTap 2 with a custom `DisableEnter` extension and `addKeyboardShortcuts` for all structural key operations. Use fractional-indexing (already installed) for position recalculation on all move operations.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| react | 18.x | UI rendering | Industry standard; Tauri v2 templates use React 18; concurrent mode features available |
| react-dom | 18.x | DOM binding | Paired with React |
| @vitejs/plugin-react | 4.x | Vite HMR + JSX transform | Official Vite React plugin; required to add JSX support to existing Vite project |
| react-arborist | 3.4.3 | Virtualized tree view with drag-and-drop and keyboard navigation | Complete tree component with built-in virtualization (react-window), DnD, keyboard nav, customizable node renderer |
| @tiptap/react | 2.x | Per-node rich text editor | Already chosen in Phase 1 as content format (ProseMirror JSON); has `addKeyboardShortcuts` API |
| @tiptap/starter-kit | 2.x | TipTap extension bundle | Basic document/paragraph/text; disables Enter at extension level for single-line nodes |
| zustand | 4.x or 5.x | Client state management | Minimal boilerplate, hook-based, works cleanly with async IPC calls; slice pattern for tree + zoom state |
| fractional-indexing | 3.2.0 | Position key generation | Already installed; `generateKeyBetween(prev, next)` for insert/move positions |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @tauri-apps/api | 2.x | Tauri IPC core | Already installed/used; required for all IPC commands |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| react-arborist | Custom flat list + manual DnD | react-arborist provides built-in virtualization (react-window), DnD handling, keyboard nav, and multi-select for free. Custom implementation would take 3-5x longer and miss edge cases (drop zone detection, drag preview) |
| react-arborist | @mui/x-tree-view RichTreeView | MUI brings heavy design system dependency; overkill; less keyboard flexibility |
| react-arborist | dnd-kit-sortable-tree | Younger library, less battle-tested for nested trees; requires more wiring |
| zustand | React Context + useReducer | Context causes full subtree re-renders on every tree mutation; Zustand with selectors re-renders only subscribed components |
| TipTap | Plain contenteditable div | TipTap handles cursor positioning, IME, paste normalization, and the ProseMirror JSON round-trip that Phase 1 already standardized |

**Installation:**

```bash
npm install react react-dom react-arborist @tiptap/react @tiptap/starter-kit zustand
npm install -D @vitejs/plugin-react @types/react @types/react-dom
```

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── components/
│   ├── Outliner/
│   │   ├── OutlinerView.tsx       # root container, zoom state, breadcrumb
│   │   ├── NodeRow.tsx            # react-arborist node renderer
│   │   ├── NodeEditor.tsx         # TipTap instance per node
│   │   ├── Breadcrumb.tsx         # zoom trail navigation
│   │   └── Bullet.tsx             # click-to-zoom dot
│   └── App.tsx
├── store/
│   ├── treeStore.ts               # Zustand store: tree data, zoom, focus
│   └── ipc.ts                     # typed wrappers around bindings.ts commands
├── lib/
│   └── bindings.ts                # tauri-specta generated (already exists)
├── utils/
│   ├── treeHelpers.ts             # flat→nested hydration, findPath, fractional ops
│   └── keyboard.ts                # shared keyboard shortcut constants
├── app.ts                         # existing entry (will be replaced by React mount)
├── main.ts                        # existing entry point
└── style.css
```

### Pattern 1: Flat IPC → Nested Tree Hydration

**What:** The Phase 1 backend returns flat rows from `get_children(parent_id)`. react-arborist consumes a nested tree (`{ id, children: [...] }`). A hydration function recursively builds the nested structure by calling `get_children` for each expanded node.

**When to use:** Initial load and on any structural mutation (create, move, delete).

```typescript
// Source: Phase 1 bindings.ts + react-arborist data contract
import { commands } from '../lib/bindings'
import { generateKeyBetween } from 'fractional-indexing'

export interface TreeNode {
  id: string
  name: string           // derived from content JSON
  content: JsonValue
  position: string
  collapsed: boolean
  parent_id: string | null
  children?: TreeNode[]
}

async function loadChildren(parentId: string | null): Promise<TreeNode[]> {
  const result = await commands.getChildren(parentId)
  if (result.status === 'error') throw new Error(result.error)
  return result.data.map(node => ({
    id: node.id,
    name: extractText(node.content),  // ProseMirror JSON → plain text for arborist
    content: node.content,
    position: node.position,
    collapsed: node.collapsed,
    parent_id: node.parent_id,
    // children loaded lazily on expand
    children: node.collapsed ? [] : undefined,
  }))
}
```

**Critical:** react-arborist treats `children: []` (empty array) as an expandable folder and `children: undefined` (or absent) as a leaf. For Workflowy-style behavior (any node can have children), always initialize `children: []` and populate on expand.

### Pattern 2: Controlled Tree with Zustand Store

**What:** Use react-arborist in controlled mode (`data` prop, not `initialData`). The Zustand store holds the full nested tree. All mutations (onMove, onCreate, onDelete, onToggle) call IPC then update the store.

**When to use:** Required for this project — uncontrolled mode would lose sync with SQLite.

```typescript
// Source: react-arborist docs, Zustand docs
import { create } from 'zustand'
import { TreeNode } from '../utils/treeHelpers'

interface TreeState {
  nodes: TreeNode[]
  zoomedNodeId: string | null
  focusedNodeId: string | null
  setNodes: (nodes: TreeNode[]) => void
  setZoomedNode: (id: string | null) => void
}

export const useTreeStore = create<TreeState>((set) => ({
  nodes: [],
  zoomedNodeId: null,
  focusedNodeId: null,
  setNodes: (nodes) => set({ nodes }),
  setZoomedNode: (id) => set({ zoomedNodeId: id }),
}))
```

### Pattern 3: TipTap Single-Line Node with Outliner Keys

**What:** Each node uses a TipTap editor configured for single-line text (no Enter = new paragraph). Enter is intercepted to create a new sibling. Tab/Shift-Tab are intercepted to indent/outdent.

**When to use:** Every node row.

```typescript
// Source: TipTap docs (addKeyboardShortcuts), tiptap.dev/docs/editor/api/keyboard-shortcuts
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Extension } from '@tiptap/core'

const OutlinerKeys = Extension.create({
  name: 'outlinerKeys',
  addKeyboardShortcuts() {
    return {
      // Intercept Enter — do NOT create paragraph, call tree action instead
      Enter: () => {
        this.options.onEnter()
        return true  // returning true prevents default TipTap Enter handling
      },
      Tab: () => {
        this.options.onIndent()
        return true
      },
      'Shift-Tab': () => {
        this.options.onOutdent()
        return true
      },
      Backspace: ({ editor }) => {
        if (editor.isEmpty) {
          this.options.onDeleteEmpty()
          return true
        }
        return false  // allow normal backspace in non-empty node
      },
    }
  },
})
```

### Pattern 4: react-arborist onMove with Fractional Indexing

**What:** When a drag completes, `onMove` provides `{ dragIds, parentId, index }`. Use `generateKeyBetween` with the positions of the node before and after the drop index to calculate the new fractional position.

**When to use:** Every drag-and-drop completion and every Alt+Arrow keyboard move.

```typescript
// Source: react-arborist onMove API, fractional-indexing README
async function handleMove({ dragIds, parentId, index }: MovePayload) {
  const siblings = getSiblingPositions(parentId, dragIds) // from store, excluding dragged nodes
  const prevPos = siblings[index - 1]?.position ?? null
  const nextPos = siblings[index]?.position ?? null
  const newPosition = generateKeyBetween(prevPos, nextPos)

  for (const id of dragIds) {
    const result = await commands.updateNode(id, null, newPosition, null, null)
    // also update parent_id if re-nesting — requires new IPC command or extend update_node
  }
  // re-hydrate affected subtrees in store
}
```

**Critical gap:** Phase 1's `update_node` IPC command does NOT support updating `parent_id`. Re-nesting (moving under a new parent) requires either extending the Rust command or implementing a delete+recreate pattern. Extending `update_node` is strongly preferred.

### Pattern 5: Zoom/Hoist with Breadcrumb

**What:** Store `zoomedNodeId` in the Zustand store. When non-null, pass `zoomedNodeId` as the root to `get_children`. Build the breadcrumb by walking up the parent chain.

**When to use:** Click on bullet dot → zoom in. Click breadcrumb segment → zoom to that ancestor.

```typescript
// Pattern derived from Phase 1 IPC + CONTEXT.md zoom spec
async function buildBreadcrumb(nodeId: string): Promise<TreeNode[]> {
  const trail: TreeNode[] = []
  let current: string | null = nodeId
  while (current) {
    const result = await commands.getNode(current)
    if (result.status === 'error') break
    trail.unshift({ ...result.data, name: extractText(result.data.content) })
    current = result.data.parent_id
  }
  return trail  // [root, ..., parent, current]
}
```

### Anti-Patterns to Avoid

- **Nested IPC calls on every render:** Never call `get_children` inside a React render or component body. Load on mount and on explicit expand. Cache in Zustand store.
- **Using `initialData` (uncontrolled mode):** react-arborist's internal mutations won't sync to SQLite. Always use `data` prop with controlled callbacks.
- **Allowing TipTap Enter to bubble:** TipTap's default Enter creates a new paragraph inside the node's ProseMirror document. The outliner Enter should create a new sibling NODE. Always return `true` in the Enter shortcut handler.
- **Tracking `children: undefined` for expanded nodes:** react-arborist shows expand arrow only when `children` is an array (even empty). Nodes that have never loaded children should start as `children: []`, not `undefined`.
- **Per-node TipTap instance without cleanup:** Each `useEditor` creates a ProseMirror instance. In a list of 1000 nodes, only render TipTap for the focused/editing node; render plain text for others. Use `editable: false` or a read-only span for non-focused rows.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Tree virtualization | Custom windowed list with absolute positioning | react-arborist (uses react-window internally) | Off-screen node recycling, variable height, scroll jump prevention are all non-trivial |
| Drag-and-drop with nesting indicators | Custom HTML5 DnD with drop zone math | react-arborist built-in DnD | Nesting depth detection from mouse X position, drop preview cursor, touch/mouse normalization |
| Fractional position generation | Custom base-62 string generator | `fractional-indexing` (already installed) | Edge cases: generating keys at the very start/end, keys that collide after millions of insertions |
| ContentEditable cursor management | Plain div with cursor position tracking | TipTap | IME (CJK), selection range preservation on re-render, clipboard paste normalization |
| Tree keyboard navigation (arrows) | Manual focus management with refs | react-arborist built-in (arrow keys traverse visible nodes) | Row virtualization changes DOM presence; arborist tracks focus internally |

**Key insight:** The two hardest problems in an outliner — maintaining cursor position across tree mutations and reliably computing drop targets during drag — are solved by TipTap and react-arborist respectively. Both libraries encode years of edge-case fixes. Build the adapter/glue layer, not the core behaviors.

---

## Common Pitfalls

### Pitfall 1: react-arborist Expects Nested Data, Backend Returns Flat

**What goes wrong:** Calling `get_children(null)` returns root-level flat nodes. Passing this flat array directly to react-arborist `data` prop will render only the root level with no nesting.

**Why it happens:** Phase 1 backend is a relational adjacency list (each node has `parent_id`). react-arborist consumes hierarchical `children` arrays.

**How to avoid:** Build a `hydrate(rootId: string | null, depth: number)` function that recursively calls `get_children` for each visible node. Load lazily on `onToggle` — only expand the clicked subtree.

**Warning signs:** Tree renders but is flat; all nodes appear at the same depth.

### Pitfall 2: Tab Key Stolen by Browser/TipTap Before Tree Handler

**What goes wrong:** Tab key is intercepted by the browser's default focus traversal. TipTap also has a built-in Tab handler in StarterKit (list indentation). The outliner Tab handler may never fire.

**Why it happens:** Event bubbling order: TipTap ProseMirror keydown → DOM synthetic event → react-arborist container. TipTap's default Tab extension handles Tab first.

**How to avoid:** Add the `OutlinerKeys` extension (Pattern 3) which returns `true` from Tab, preventing StarterKit's Tab handler and DOM default. Verify by checking `e.defaultPrevented` in the row onKeyDown.

**Warning signs:** Tab moves browser focus instead of indenting; Shift-Tab moves focus backward through the page.

### Pitfall 3: `update_node` Does Not Accept `parent_id` — Re-nesting Silently Fails

**What goes wrong:** Drag-and-drop or Alt+Arrow moves a node under a new parent, but `update_node` only updates `position`. The node remains under the old parent in SQLite.

**Why it happens:** Phase 1 `update_node` IPC command signature: `(id, content?, position?, collapsed?, metadata?)` — no `parent_id` field.

**How to avoid:** Add `parent_id: Option<String>` as an optional field to the `update_node` Rust command before implementing drag-to-reparent or Alt+Arrow cross-parent moves. This is a Wave 0 backend task.

**Warning signs:** Move appears to work visually (store updated) but reverts after app restart; drag creates duplicate nodes.

### Pitfall 4: TipTap Instance Per Node Causes Memory and Performance Issues

**What goes wrong:** Creating a TipTap `useEditor` instance for every tree node (even if 1000 are visible) instantiates 1000 ProseMirror editors. Memory climbs, initial render is slow.

**Why it happens:** Each TipTap editor runs a full ProseMirror state machine.

**How to avoid:** Render a lightweight `<span>` or plain text for non-editing nodes. Mount TipTap only for the currently focused/editing node. Use `onFocus`/`onBlur` to swap the TipTap instance in. react-arborist's virtualization means only ~20-40 rows are in the DOM, but still only ONE should be a live TipTap instance.

**Warning signs:** Slow typing after navigating through many nodes; browser memory profiler shows hundreds of ProseMirror instances.

### Pitfall 5: React Not Yet in the Project

**What goes wrong:** The current project is vanilla TypeScript with no React. Phase 2 is the first React code. The vite.config.ts must be updated to include `@vitejs/plugin-react`.

**Why it happens:** Phase 1 focused solely on the Rust/IPC layer.

**How to avoid:** First task in Wave 0: install React dependencies and update vite.config.ts. src/main.ts must be converted to tsx or a new main.tsx entry point must be added.

**Warning signs:** JSX syntax throws Vite parse errors; `React is not defined` runtime errors.

### Pitfall 6: Fractional Index Collision on Rapid Sequential Inserts

**What goes wrong:** Creating multiple nodes rapidly (Enter key held down) generates positions in sequence. If the parent array is not updated between IPC calls, `generateKeyBetween(prev, next)` is called with stale values, producing duplicate positions.

**Why it happens:** Each `create_node` call is async. The store's node list may not reflect the last-created node before the next Enter fires.

**How to avoid:** Track the "last created position" in the store optimistically. Update the local positions list immediately on create, before the IPC response, so the next `generateKeyBetween` call uses the correct predecessor.

**Warning signs:** Two nodes end up with the same `position` value; `ORDER BY position ASC` returns them in arbitrary order.

---

## Code Examples

Verified patterns from official sources:

### Vite Config Update for React

```typescript
// Source: https://v2.tauri.app/start/frontend/vite/
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
```

### react-arborist Controlled Tree

```typescript
// Source: react-arborist README, react-arborist.netlify.app
import { Tree, NodeRendererProps } from 'react-arborist'

function OutlinerView() {
  const nodes = useTreeStore(s => s.nodes)

  return (
    <Tree
      data={nodes}
      onMove={handleMove}
      onCreate={handleCreate}
      onDelete={handleDelete}
      onToggle={handleToggle}
      rowHeight={28}
      indent={24}
      width="100%"
      height={window.innerHeight}
      openByDefault={true}
    >
      {NodeRow}
    </Tree>
  )
}

function NodeRow({ node, style, dragHandle }: NodeRendererProps<TreeNode>) {
  return (
    <div style={style} ref={dragHandle} onKeyDown={handleRowKeyDown}>
      <Bullet node={node} onClick={() => zoomInto(node.id)} />
      <NodeEditor node={node} />
    </div>
  )
}
```

### TipTap Single-Line with Outliner Extensions

```typescript
// Source: https://tiptap.dev/docs/editor/api/keyboard-shortcuts
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Extension } from '@tiptap/core'

function NodeEditor({ node, onEnter, onIndent, onOutdent, onDeleteEmpty }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // disable features not needed in single-line node
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
      }),
      OutlinerKeys.configure({ onEnter, onIndent, onOutdent, onDeleteEmpty }),
    ],
    content: node.content,
    onUpdate: ({ editor }) => {
      debouncedSave(node.id, editor.getJSON())
    },
  })

  return <EditorContent editor={editor} />
}
```

### Zustand Store with Async IPC

```typescript
// Source: Zustand docs (zustand.docs.pmnd.rs), Phase 1 bindings.ts
import { create } from 'zustand'
import { commands } from '../lib/bindings'

export const useTreeStore = create<TreeState>()((set, get) => ({
  nodes: [],
  zoomedNodeId: null,

  loadRoot: async () => {
    const { zoomedNodeId } = get()
    const result = await commands.getChildren(zoomedNodeId)
    if (result.status === 'ok') {
      set({ nodes: await hydrateNodes(result.data) })
    }
  },

  createNode: async (parentId: string | null, afterPosition: string | null) => {
    const siblings = get().nodes  // get current sibling positions
    const nextPos = null  // simplified; use fractional-indexing in real impl
    const pos = generateKeyBetween(afterPosition, nextPos)
    const result = await commands.createNode(
      parentId, pos, { type: 'note' }, { type: 'doc', content: [{ type: 'paragraph' }] }, null
    )
    if (result.status === 'ok') {
      get().loadRoot()  // re-hydrate; optimize with local insert later
    }
  },
}))
```

### Fractional Position for Sibling Insert

```typescript
// Source: https://github.com/rocicorp/fractional-indexing
import { generateKeyBetween } from 'fractional-indexing'

function positionForInsertAfter(
  siblings: TreeNode[],  // ordered by position
  afterIndex: number      // insert after this index (-1 = before first)
): string {
  const prev = afterIndex >= 0 ? siblings[afterIndex].position : null
  const next = afterIndex + 1 < siblings.length ? siblings[afterIndex + 1].position : null
  return generateKeyBetween(prev, next)
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Custom hand-rolled tree with react-virtualized | react-arborist (wraps react-window, adds DnD + keyboard) | 2022-present | Drop-in solution; removes ~2000 lines of infrastructure code |
| react-beautiful-dnd for sorted lists | @dnd-kit/sortable or react-arborist built-in DnD | 2023 | react-beautiful-dnd deprecated; react-arborist's DnD handles nested trees |
| Plain contenteditable for inline editing | TipTap / ProseMirror-based | 2021-present | Cursor management, IME, paste, JSON serialization handled correctly |
| Redux for tree state | Zustand with slices | 2023-present | Less boilerplate, no reducers/actions needed for straightforward async IPC |
| Full-tree re-fetch on every mutation | Optimistic updates + targeted re-fetch | Ongoing | Prevents visible flicker; async IPC latency is 1-5ms locally but optimistic update still improves feel |

**Deprecated/outdated:**
- `react-beautiful-dnd`: Deprecated by Atlassian; do not use for new projects. react-arborist's built-in DnD covers this use case.
- TipTap v1: Replaced by TipTap v2 with breaking API changes; use `@tiptap/react` v2.x.
- react-arborist `initialData` (uncontrolled): Workable for read-only trees, but incompatible with a backend-persisted controlled tree. Use `data` prop.

---

## Open Questions

1. **Should `update_node` Rust command be extended with `parent_id`?**
   - What we know: Current command accepts `content, position, collapsed, metadata`. Re-nesting requires changing `parent_id`.
   - What's unclear: Whether to extend `update_node` or add a separate `move_node(id, new_parent_id, new_position)` command.
   - Recommendation: Add `move_node` as a dedicated IPC command — cleaner semantics, easier to reason about in Rust, prevents accidental `parent_id` mutation from the content-editing path.

2. **Lazy load vs eager load tree depth?**
   - What we know: `get_children` returns one level at a time. An eager full-tree load would require N+1 IPC calls for N nodes.
   - What's unclear: At what tree depth/size does lazy loading feel noticeably better than eager loading?
   - Recommendation: Lazy load on expand (already the standard react-arborist pattern with `onToggle`). Pre-load 2 levels on initial mount to avoid visible loading flicker on small trees.

3. **How to handle TipTap editor focus across virtualized rows?**
   - What we know: react-arborist virtualizes rows — DOM nodes are recycled. TipTap instances mounted in virtualized rows may get unmounted.
   - What's unclear: Whether to mount one global TipTap instance outside the virtualizer that moves to the focused node's position, or mount per-row and accept mount/unmount on scroll.
   - Recommendation: One global TipTap instance, absolutely positioned to overlay the focused node's row. This is the pattern used by Notion and Roam; it avoids the scroll-unmount problem entirely.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (no test framework currently installed — Wave 0 gap) |
| Config file | `vitest.config.ts` — Wave 0 creation |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TREE-01 | `hydrateNodes` converts flat IPC response to nested `children` arrays | unit | `npx vitest run src/utils/treeHelpers.test.ts` | ❌ Wave 0 |
| TREE-01 | `positionForInsertAfter` returns valid fractional key between neighbors | unit | `npx vitest run src/utils/treeHelpers.test.ts` | ❌ Wave 0 |
| TREE-02 | `update_node(collapsed: true)` persists and reloads as collapsed | integration (manual) | manual — requires live Tauri IPC | manual-only |
| TREE-03 | `buildBreadcrumb` walks parent chain to root correctly | unit | `npx vitest run src/utils/treeHelpers.test.ts` | ❌ Wave 0 |
| TREE-04 | Keyboard extension `Enter` returns `true` (prevents TipTap paragraph) | unit | `npx vitest run src/utils/keyboard.test.ts` | ❌ Wave 0 |
| TREE-06 | `handleMove` computes correct fractional position for reorder | unit | `npx vitest run src/utils/treeHelpers.test.ts` | ❌ Wave 0 |

**Manual-only justification for TREE-02:** `collapsed` persists via Tauri IPC to SQLite. Vitest runs in a Node.js context without the Tauri WebView environment; IPC calls cannot be invoked. Validate collapse persistence by: (1) collapsing a node, (2) restarting the app, (3) confirming the node starts collapsed.

### Sampling Rate

- **Per task commit:** `npx vitest run src/utils/`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `vitest` and `@vitest/ui` — install: `npm install -D vitest`
- [ ] `vitest.config.ts` — configure with `environment: 'jsdom'` for React component tests
- [ ] `src/utils/treeHelpers.test.ts` — covers TREE-01 (hydration), TREE-03 (breadcrumb), TREE-06 (move positions)
- [ ] `src/utils/keyboard.test.ts` — covers TREE-04 (keyboard extension returns true)

---

## Sources

### Primary (HIGH confidence)

- `react-arborist` GitHub: https://github.com/brimdata/react-arborist — feature list, API props, onMove/onCreate/onDelete/onToggle callbacks, keyboard customization via issue #57
- react-arborist LogRocket article (June 2024): https://blog.logrocket.com/using-react-arborist-create-tree-components/ — node renderer props, tree ref API, controlled vs uncontrolled patterns
- TipTap keyboard shortcuts docs: https://tiptap.dev/docs/editor/api/keyboard-shortcuts — `addKeyboardShortcuts`, returning `true` to override default behavior
- Tauri v2 Vite setup: https://v2.tauri.app/start/frontend/vite/ — `@vitejs/plugin-react` integration with existing Tauri Vite config
- fractional-indexing README: https://github.com/rocicorp/fractional-indexing — `generateKeyBetween(prev, next)` signature, null handling for first/last positions
- Phase 1 code: `src-tauri/src/commands/nodes.rs` — confirmed `update_node` signature lacks `parent_id`
- Phase 1 bindings: `src/lib/bindings.ts` — all 5 IPC commands typed and available

### Secondary (MEDIUM confidence)

- Zustand docs: https://zustand.docs.pmnd.rs/ — slice pattern, async actions, devtools middleware
- TipTap Enter disable discussion: https://github.com/ueberdosis/tiptap/discussions/2948 — `Extension.create` with `addKeyboardShortcuts` returning `true` for Enter confirmed working pattern
- react-arborist keyboard shortcut status: https://github.com/brimdata/react-arborist/issues/57 — configurable shortcuts implemented in development branch (April 2024 update by maintainer)

### Tertiary (LOW confidence)

- One global TipTap instance pattern: derived from Notion/Roam approach described in community discussions, not from official docs. Recommended as Open Question for planner to decide.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — React, react-arborist, TipTap all verified via official docs and active npm; Zustand confirmed current standard
- Architecture: HIGH — controlled tree pattern, IPC adapter layer, and TipTap keyboard extension verified via official sources
- Pitfalls: HIGH — `parent_id` gap in `update_node` confirmed by reading actual Phase 1 code; Tab key interception pattern confirmed by TipTap discussion thread

**Research date:** 2026-03-24
**Valid until:** 2026-04-24 (react-arborist is stable at 3.4.x; TipTap v2 API stable)
