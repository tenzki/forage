# Phase 3: Search and Editing - Research

**Researched:** 2026-03-25
**Domain:** TipTap marks/extensions, SQLite FTS5, persistent undo/redo, hashtag system, Cmd+K search overlay
**Confidence:** HIGH (core stack verified via official docs; architecture patterns verified against existing codebase)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Search UX:**
- Cmd+K overlay panel (Spotlight/Linear style) — centered modal above the tree
- Full-text search using SQLite FTS5 on extracted text from TipTap JSON content
- Results show: node text with match highlighted, breadcrumb ancestor path (Home > Parent > Node), and text snippet around match
- Selecting a result zooms/hoists into that node (reuses existing zoom behavior), overlay closes
- Keyboard-navigable results (arrow keys to select, Enter to navigate)

**Undo/Redo:**
- Covers both text edits AND structural operations (indent, outdent, move, delete, create) — single unified Cmd+Z/Cmd+Shift+Z
- Global undo stack (not scoped to zoom level) — last action undone regardless of where it happened
- Full history persisted in the database — user can undo all the way back to the beginning, survives app restarts
- Text edits grouped by pause (~1s gap between keystrokes or node switch = new undo step)
- Structural operations are each a single undo step

**Markdown Formatting:**
- Bold, italic, and inline code supported via TipTap marks (StarterKit already includes these)
- No block-level Markdown (headings, blockquotes, code blocks, lists remain disabled)
- Standard keyboard shortcuts: Cmd+B (bold), Cmd+I (italic), Cmd+E (code)

**Hashtags:**
- Typing #hashtag inline creates a visually highlighted tag with distinct color
- Hashtags are clickable — clicking opens search filtered to that tag
- Left sidebar (toggleable) shows all tags with counts
- Autocomplete dropdown appears after typing '#' + 2 characters, suggesting existing tags
- Tags indexed in database for fast lookup and sidebar population

**AI Content Styling:**
- Icon-only approach — small sparkle/AI icon replaces the bullet dot on agent_response nodes
- Icon shown on ALL nodes with node_type='agent_response', not just top-level of a branch
- Right-click context menu includes "Make mine" to convert AI node to regular user node (changes node_type to 'note', removes icon)
- Minimal and non-disruptive — fits Workflowy-minimal aesthetic from Phase 2

### Claude's Discretion
- FTS5 index structure and tokenizer choice
- Undo/redo database schema for persistent history
- Exact hashtag color and autocomplete dropdown styling
- Search overlay animation and keyboard shortcut details
- Tag sidebar layout and toggle shortcut
- Context menu implementation approach

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TREE-05 | User can search across all nodes with results navigable in context | FTS5 virtual table pattern, `cmdk` overlay, snippet() for context, IPC command search_nodes |
| EDIT-01 | User can undo and redo structural and text operations | Persistent undo_history table, event-sourced snapshots, Zustand stack wrapper |
| EDIT-02 | User can use inline Markdown formatting (bold, italic, code) | TipTap StarterKit marks already included — enable Cmd+B/I/E, verify no disable in configure() |
| EDIT-03 | User can tag nodes with #hashtags parsed from content | TipTap custom Node extension + Suggestion utility, tags table, sidebar component |
| EDIT-04 | AI-generated content is visually distinguished from user-written content | node_type='agent_response' in existing schema, modify Bullet.tsx for sparkle icon, context menu |
</phase_requirements>

---

## Summary

Phase 3 builds search and editing on top of the Phase 2 foundation (TipTap v3 + Zustand + SQLite via Tauri IPC). The codebase is in excellent shape: `StarterKit` already provides bold/italic/code marks that just need their keyboard shortcuts confirmed active; `extractText()` already exists for FTS5 indexing; `node_type='agent_response'` is already stored in the DB; `Bullet.tsx` and the zoom/hoist system provide the integration points for AI styling and search navigation respectively.

The two hardest problems in this phase are (1) **persistent undo/redo** — storing complete snapshots before/after each operation requires a new `undo_history` table and a wrapping layer in the Zustand store — and (2) **the hashtag system** — which requires a custom TipTap Node extension (not a Mark), the Suggestion utility for autocomplete, a `node_tags` index table in SQLite, and a new sidebar component. These are each ~1 plan unit of work.

**Primary recommendation:** Implement in four focused plans: (1) FTS5 search + Cmd+K overlay, (2) persistent undo/redo, (3) hashtag inline node + sidebar + autocomplete, (4) AI styling + context menu. Bold/italic/code marks are effectively free — they're already in StarterKit and need only a keyboard shortcut verification and CSS styling pass.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@tiptap/core` | ^3.20.5 (already installed) | Extension API for custom Mark/Node/Suggestion | Project already uses TipTap v3 |
| `@tiptap/starter-kit` | ^3.20.5 (already installed) | Bold, Italic, Code marks included | Project already uses StarterKit |
| `@tiptap/suggestion` | ^3.x (add) | Autocomplete popup utility for hashtag `#` trigger | Official TipTap utility, powers Mention extension |
| `cmdk` | ^1.1.1 (add) | Headless, zero-dependency Cmd+K command palette | Powers Linear/Vercel, keyboard-native, no styling lock-in |
| SQLite FTS5 | built-in to SQLite | Full-text search across node content | FTS5 is bundled in Apple's SQLite — no extra crate needed |
| `sqlx` | current (already used) | Execute FTS5 queries + undo history writes in Rust | Already the Rust DB layer |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Tauri IPC (existing) | Tauri v2 | Bridge between frontend search UI and Rust FTS5 | All search/undo/tag IPC calls |
| Zustand (existing) | ^5.0.12 | Undo stack state, search overlay open/close | Wrap existing store actions |
| `@tiptap/extension-mention` | (reference only) | Reference implementation for Suggestion | Study its source; hashtag uses same pattern but custom Node |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `cmdk` | `kbar`, custom modal | cmdk is headless, 0-dep, best keyboard UX; kbar adds more abstraction than needed |
| FTS5 content= external table | FTS5 direct insert | External content table keeps one source of truth (nodes table); triggers handle sync |
| Snapshot-based undo | Event-sourced operations log | Snapshots are simpler to implement and replay; event sourcing requires inverse operations for every command |
| Custom hashtag Mark | TipTap Node extension | Node is correct: hashtags are atomic, not partial selections; Mark can span across node boundaries |

**Installation:**
```bash
npm install cmdk @tiptap/suggestion
```

---

## Architecture Patterns

### Recommended Project Structure
```
src/
├── components/
│   ├── Outliner/
│   │   ├── Bullet.tsx            # MODIFY: sparkle icon for agent_response
│   │   ├── NodeEditor.tsx        # MODIFY: Cmd+B/I/E enabled, HashtagNode extension
│   │   ├── NodeRow.tsx           # MODIFY: right-click context menu
│   ├── Search/
│   │   ├── SearchOverlay.tsx     # NEW: Cmd+K modal, cmdk Command components
│   │   └── SearchResultItem.tsx  # NEW: result row with breadcrumb + snippet
│   └── TagSidebar/
│       ├── TagSidebar.tsx        # NEW: toggleable left sidebar with tag counts
│       └── TagList.tsx           # NEW: list of tag + count rows
├── extensions/
│   └── HashtagNode.tsx           # NEW: TipTap custom Node extension with Suggestion
src-tauri/
├── migrations/
│   └── 0002_search_and_editing.sql  # NEW: FTS5 + undo_history + node_tags tables
├── src/commands/
│   └── search.rs                 # NEW: search_nodes, get_undo_history, undo_step, redo_step, get_tags commands
```

### Pattern 1: FTS5 External Content Table

**What:** FTS5 virtual table indexes extracted plain text from `nodes.content` (JSON). External content mode keeps nodes as the single source of truth. Three SQL triggers (INSERT/UPDATE/DELETE on nodes) keep the FTS index in sync automatically.

**When to use:** Any time you need full-text search against content already stored in a real table.

```sql
-- Source: https://sqlite.org/fts5.html (External Content Tables section)
-- Migration: 0002_search_and_editing.sql

CREATE VIRTUAL TABLE nodes_fts USING fts5(
    content_text,          -- extracted plain text from TipTap JSON
    content='',            -- empty string = contentless (we manage sync manually via triggers)
    tokenize='unicode61'   -- handles Unicode, case-insensitive by default
);

-- Sync triggers
CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes BEGIN
    -- Frontend calls extract_text before insert; stored as node_text column
    -- OR we use an application-level sync on update_node IPC call
END;
```

**Practical approach for this project:** Because `content` is ProseMirror JSON (not plain text), the Rust `update_node` command already receives plain text via a new `text` parameter, or we extract it server-side. The cleanest pattern: add a `content_text TEXT` column to nodes table (populated on write), and run FTS5 as a content= table pointing at it.

```sql
-- Simpler: add content_text to nodes, FTS5 references it
ALTER TABLE nodes ADD COLUMN content_text TEXT NOT NULL DEFAULT '';

CREATE VIRTUAL TABLE nodes_fts USING fts5(
    content_text,
    content='nodes',
    content_rowid='rowid'    -- nodes uses rowid internally (UUID TEXT PK has implicit rowid)
);

-- Triggers to keep FTS in sync
CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;
CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
END;
CREATE TRIGGER nodes_fts_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
    INSERT INTO nodes_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;
```

### Pattern 2: FTS5 Search Query with Snippet

**What:** Query FTS5 for matching rows, return node IDs plus a highlighted snippet.

```sql
-- Source: https://sqlite.org/fts5.html (snippet() function)
SELECT
    n.id,
    n.parent_id,
    n.node_type,
    snippet(nodes_fts, 0, '<mark>', '</mark>', '...', 20) AS snippet
FROM nodes_fts
JOIN nodes n ON n.rowid = nodes_fts.rowid
WHERE nodes_fts MATCH ?1
ORDER BY rank
LIMIT 20;
```

The `snippet()` arguments: column index (0), open mark, close mark, ellipsis, max tokens (1-64). Results are ranked by BM25 by default when using `ORDER BY rank`.

### Pattern 3: Cmd+K Search Overlay with `cmdk`

**What:** Floating modal opened by Cmd+K, implemented with the headless `cmdk` library. Positioned above `OutlinerView` using React portal or absolute positioning.

**When to use:** Any keyboard-first command/search palette pattern.

```tsx
// Source: https://cmdk.paco.me (official cmdk docs)
import { Command } from 'cmdk'

export function SearchOverlay({ open, onClose }: Props) {
  return (
    <div className="search-overlay-backdrop" onClick={onClose}>
      <Command.Dialog open={open} onOpenChange={onClose} label="Search nodes">
        <Command.Input placeholder="Search all nodes..." />
        <Command.List>
          <Command.Empty>No results found.</Command.Empty>
          {results.map((r) => (
            <Command.Item key={r.id} onSelect={() => handleSelect(r)}>
              <SearchResultItem result={r} />
            </Command.Item>
          ))}
        </Command.List>
      </Command.Dialog>
    </div>
  )
}
```

Cmd+K registration: `useEffect` with `keydown` listener on `document`, guard with `e.metaKey && e.key === 'k'`.

### Pattern 4: Persistent Undo/Redo

**What:** Each undoable operation stores a before/after snapshot of the affected node(s) in an `undo_history` table. Undo replays the "before" state; redo replays the "after" state. A pointer tracks current position in history.

**Schema:**
```sql
CREATE TABLE undo_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    operation   TEXT NOT NULL,      -- 'text_edit' | 'structural'
    node_id     TEXT NOT NULL,
    before_json TEXT NOT NULL,      -- full Node snapshot as JSON
    after_json  TEXT NOT NULL,      -- full Node snapshot as JSON
    group_key   TEXT,               -- NULL for structural; timestamp bucket for text edits
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Current position pointer
CREATE TABLE undo_pointer (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    position    INTEGER NOT NULL DEFAULT 0  -- ID of last applied entry
);
INSERT OR IGNORE INTO undo_pointer VALUES (1, 0);
```

**Frontend wrapping:** Each action in `treeStore.ts` (createNode, deleteNode, indentNode, etc.) calls a new IPC command `record_undo_step(before_snapshot, after_snapshot, operation)` after completing. Text edits are grouped client-side by debouncing: a 1-second gap between `updateContent` calls or a node switch creates a new undo group.

**Undo execution (Rust):**
```rust
// Pseudo-code for undo_step IPC command
// 1. Read undo_history WHERE id = (SELECT position FROM undo_pointer)
// 2. Apply before_json to nodes table for that node_id
// 3. Decrement undo_pointer.position
// 4. Return updated node to frontend
```

### Pattern 5: Hashtag as TipTap Inline Node

**What:** Custom TipTap `Node` extension (not Mark) that renders `#tag` as an atomic inline element with distinct styling. Uses the `Suggestion` utility for autocomplete after typing `#` + 2 chars.

**Why Node, not Mark:** Marks apply to a text range; hashtags are atomic units. A Node extension renders a non-editable chip that can be selected and deleted as a whole.

```tsx
// Source: https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/node
import { Node, mergeAttributes } from '@tiptap/core'
import { Suggestion } from '@tiptap/suggestion'
import type { SuggestionOptions } from '@tiptap/suggestion'

export const HashtagNode = Node.create({
  name: 'hashtag',
  group: 'inline',
  inline: true,
  selectable: false,
  atom: true,            // non-editable atomic unit

  addAttributes() {
    return {
      tag: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-hashtag]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-hashtag': node.attrs.tag, class: 'hashtag' }, HTMLAttributes), `#${node.attrs.tag}`]
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: '#',
        startOfLine: false,
        items: async ({ query }) => {
          // IPC call: get_tags_matching(query)
          return await fetchTagSuggestions(query)
        },
        command: ({ editor, range, props }) => {
          editor.chain()
            .focus()
            .deleteRange(range)
            .insertContent({ type: 'hashtag', attrs: { tag: props.tag } })
            .run()
        },
        render: () => renderSuggestionPopup(),  // Returns popup controller
      }),
    ]
  },
})
```

**Tag extraction for DB:** After each `updateContent` call, parse the TipTap JSON to extract all `hashtag` nodes, diff against stored tags, and upsert into `node_tags` table via IPC.

### Pattern 6: AI Icon in Bullet.tsx

**What:** `Bullet.tsx` already renders the bullet dot for every node. Check `node.node_type === 'agent_response'` and swap in a sparkle SVG icon. No new component needed.

```tsx
// Modify Bullet.tsx
function Bullet({ node }: { node: TreeNode }) {
  if (node.node_type === 'agent_response') {
    return <span className="bullet-ai"><SparkleIcon /></span>
  }
  return <span className="bullet-dot" />
}
```

### Pattern 7: Right-Click Context Menu

**What:** A lightweight custom context menu on `NodeRow` right-click. No library needed — a `onContextMenu` handler + `useState` for position + `useEffect` to close on outside click is sufficient for the simple "Make mine" use case.

```tsx
// NodeRow.tsx addition
const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

onContextMenu={(e) => {
  if (node.node_type === 'agent_response') {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }
}}
```

### Anti-Patterns to Avoid

- **FTS5 with compile-time sqlx::query!()**: FTS5 tables are virtual — `sqlx::query!()` macro cannot introspect them at compile time. Use runtime `sqlx::query()` strings for all FTS5 operations (consistent with existing `nodes.rs` pattern).
- **Storing hashtag as a Mark**: Marks span text ranges; hashtags as marks can be split by cursor movement. Use Node extension with `atom: true`.
- **In-memory undo stack only**: The locked decision requires persistence — never rely on Zustand state alone for undo history.
- **Blocking the FTS index sync**: FTS5 trigger-based sync is synchronous with the write. Don't add a separate async sync step — triggers guarantee consistency.
- **cmdk inside TipTap editor**: The Cmd+K global listener must be on `document`, not on the TipTap editor. The editor captures keyboard events via `handleKeyDown`. Register Cmd+K at the `App` level with `useEffect`.
- **Undo scoped to current zoom**: The locked decision is global undo — the undo stack must operate on node IDs, not on the current view.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cmd+K palette keyboard navigation | Custom modal with arrow-key logic | `cmdk` Command.Dialog | Handles arrow keys, Enter, Home/End, ARIA automatically |
| Full-text search tokenization | Custom text search | SQLite FTS5 unicode61 tokenizer | Handles Unicode case folding, diacritics, word boundaries correctly |
| Hashtag autocomplete popup | Custom dropdown with position calculations | TipTap `Suggestion` utility | Handles cursor tracking, keyboard nav, trigger chars, debouncing |
| Mark bold/italic/code | Custom formatting | TipTap StarterKit (already included) | Already implemented with correct ProseMirror schema |

**Key insight:** The heavy lifting for text search (FTS5), autocomplete (Suggestion), and command palette (cmdk) all exist as production-grade solutions. The custom work is the integration glue: IPC commands, the undo schema, and the tag extraction logic.

---

## Common Pitfalls

### Pitfall 1: FTS5 `content_rowid` Mismatch with UUID PK
**What goes wrong:** The `nodes` table uses UUID TEXT as PK, but FTS5 `content_rowid=` requires INTEGER rowid. SQLite assigns implicit INTEGER rowids to all tables, but UUID PK != rowid.
**Why it happens:** FTS5 external content tables use `rowid` for joining, not the PK.
**How to avoid:** Join `nodes_fts` to `nodes` via `nodes.rowid = nodes_fts.rowid`, not `nodes.id`. After insert, retrieve `last_insert_rowid()` if you need to link.
**Warning signs:** Search returns results but JOIN to `nodes` returns NULL.

### Pitfall 2: `sqlx::query!()` Fails on FTS5 Tables
**What goes wrong:** Compile-time `sqlx::query!("SELECT ... FROM nodes_fts ...")` panics because sqlx cannot introspect virtual tables.
**Why it happens:** FTS5 tables have no schema columns visible to sqlx's type checker.
**How to avoid:** Use runtime `sqlx::query("...")` (no macro) for all FTS5 queries — consistent with existing `nodes.rs` pattern which already uses runtime queries.

### Pitfall 3: Undo History Grows Unboundedly
**What goes wrong:** Every keystroke (if not grouped) creates an undo entry, potentially millions of rows.
**Why it happens:** Text edits are high-frequency. Without grouping, each `updateContent` call (already debounced 300ms) would create an entry.
**How to avoid:** Client-side grouping: track a `currentUndoGroupKey` in Zustand (a timestamp bucket, reset after 1s gap or node switch). Only write to `undo_history` when the group closes. The Rust side stores the entry only when `record_undo_step` is called — not on every `update_node`.

### Pitfall 4: TipTap Suggestion Popup Z-Index / Portal Conflicts
**What goes wrong:** The hashtag suggestion dropdown renders behind the tree or gets clipped by overflow.
**Why it happens:** Suggestion renders into a `<div>` appended to document.body by default — CSS `overflow: hidden` parents or z-index stacking can hide it.
**How to avoid:** Render the suggestion popup using a React portal to `document.body`. Set `z-index: 1000` on the popup (above cmdk overlay's `z-index: 999`).

### Pitfall 5: Cmd+K Captured by TipTap When Editor is Active
**What goes wrong:** Pressing Cmd+K while editing a node does not open the search overlay.
**Why it happens:** TipTap's `handleKeyDown` calls `event.stopPropagation()` — the `document` keydown listener never fires.
**How to avoid:** Register Cmd+K directly inside the TipTap `OutlinerKeys` extension as a keyboard shortcut, calling the `onSearchOpen` callback, rather than relying on a document-level listener alone. Alternatively, use `window.addEventListener` with `capture: true` to intercept before TipTap.

### Pitfall 6: HashtagNode Not Serialized Correctly to JSON
**What goes wrong:** Hashtag nodes saved to DB lose their type on reload — appear as plain text.
**Why it happens:** TipTap's JSON serialization includes the node type, but if `parseHTML` does not match the `renderHTML` output exactly, re-parsing from stored JSON may fail.
**How to avoid:** Verify round-trip: `editor.getJSON()` → store in DB → `editor.setContent(storedJSON)` → hashtag node reappears as a `hashtag` type node. Test this explicitly before writing the full plan.

---

## Code Examples

### FTS5 Search Query (Rust, runtime query)
```rust
// Source: https://sqlite.org/fts5.html
// Uses runtime sqlx::query() — NOT sqlx::query!() (FTS5 not introspectable)
pub async fn search_nodes(pool: &SqlitePool, query: &str) -> Result<Vec<SearchResult>, AppError> {
    let fts_query = format!("{}*", query.trim());  // prefix match
    let rows = sqlx::query(
        r#"
        SELECT
            n.id,
            n.parent_id,
            n.node_type,
            snippet(nodes_fts, 0, '<mark>', '</mark>', '...', 20) AS snippet_text
        FROM nodes_fts
        JOIN nodes n ON n.rowid = nodes_fts.rowid
        WHERE nodes_fts MATCH ?1
        ORDER BY rank
        LIMIT 20
        "#
    )
    .bind(&fts_query)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Db(e.to_string()))?;
    // ... map rows
}
```

### FTS5 Migration SQL
```sql
-- 0002_search_and_editing.sql (excerpt)
-- content_text column for FTS indexing
ALTER TABLE nodes ADD COLUMN content_text TEXT NOT NULL DEFAULT '';

CREATE VIRTUAL TABLE nodes_fts USING fts5(
    content_text,
    content='nodes',
    content_rowid='rowid'
);

-- Sync triggers (use INSERT/DELETE/UPDATE on nodes)
CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;
CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
END;
CREATE TRIGGER nodes_fts_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
    INSERT INTO nodes_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;
```

### Undo History Schema
```sql
-- 0002_search_and_editing.sql (continued)
CREATE TABLE undo_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    operation   TEXT NOT NULL CHECK (operation IN ('text_edit', 'create', 'delete', 'move', 'indent', 'outdent')),
    node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    before_json TEXT NOT NULL,
    after_json  TEXT NOT NULL,
    group_key   TEXT,           -- NULL = standalone; timestamp bucket for text edit grouping
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE undo_pointer (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    position INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO undo_pointer VALUES (1, 0);

CREATE TABLE node_tags (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (node_id, tag)
);
CREATE INDEX idx_node_tags_tag ON node_tags (tag);
```

### TipTap StarterKit — Verify Marks Active
```tsx
// NodeEditor.tsx — current configuration already has bold/italic/code
// StarterKit v3 includes: Bold, Italic, Code marks by default
// These are NOT disabled in the current configure() call
// Keyboard shortcuts (confirmed from official docs):
//   Bold:   Cmd+B  (Mac)
//   Italic: Cmd+I  (Mac)
//   Code:   Cmd+E  (Mac)
//
// EDIT-02 is ~free: StarterKit already handles it.
// Work needed: CSS styling for mark rendering in node-editor-content

StarterKit.configure({
  heading: false,
  blockquote: false,
  codeBlock: false,
  horizontalRule: false,
  bulletList: false,
  orderedList: false,
  listItem: false,
  // bold, italic, code: NOT disabled = active with default shortcuts
})
```

### cmdk Search Overlay Registration
```tsx
// App.tsx or SearchOverlay.tsx — global Cmd+K listener
// Must use capture:true OR add to OutlinerKeys extension to bypass TipTap stopPropagation
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (e.metaKey && e.key === 'k') {
      e.preventDefault()
      setSearchOpen(true)
    }
  }
  window.addEventListener('keydown', handler, { capture: true })
  return () => window.removeEventListener('keydown', handler, { capture: true })
}, [])
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| FTS3/FTS4 | FTS5 with BM25 ranking | SQLite 3.9.0 (2015) | Better relevance ranking, unicode61 tokenizer, faster |
| Custom keyboard menu | headless `cmdk` | ~2022 | Zero-dependency, ARIA-correct, powers Linear |
| TipTap v1/v2 Mention | v3 Suggestion utility | TipTap v3 (2024) | Same API, confirmed available in ^3.x |

**Deprecated/outdated:**
- FTS3/FTS4: Superseded by FTS5. Use FTS5 always.
- `@tiptap/extension-mention` direct import for hashtag: Fine to reference but build a custom Node for hashtag to control rendering/storage behavior precisely.

---

## Open Questions

1. **`content_text` update: Rust-side vs frontend**
   - What we know: `update_node` IPC already receives the full content JSON. Rust has `serde_json` but not a TipTap JSON parser to extract text.
   - What's unclear: Should the frontend pass extracted text as a new `text` parameter to `update_node`, or should Rust traverse ProseMirror JSON to extract it?
   - Recommendation: Frontend passes `content_text` as a new optional parameter to `update_node`. The `extractText()` utility already exists in `src/types/tree.ts`. This avoids duplicating text extraction logic in Rust and keeps the frontend as the source of truth for ProseMirror JSON structure.

2. **Undo for multi-node structural operations (batchIndent, batchDelete)**
   - What we know: These operations call multiple single-node actions sequentially.
   - What's unclear: Should each individual operation in a batch get its own undo entry, or should the batch be one grouped undo step?
   - Recommendation: Batch operations use a shared `group_key` (same timestamp) so a single Cmd+Z undoes the entire batch. The Rust undo IPC rolls back all entries with the same `group_key`.

3. **Hashtag node in existing content (plain text #tags)**
   - What we know: Phase 2 content is stored as ProseMirror JSON. Plain text `#tag` in existing nodes are text nodes, not HashtagNode instances.
   - What's unclear: Should existing content be migrated (parsed and re-serialized)?
   - Recommendation: No migration. Only new edits create HashtagNode entries. The tag sidebar counts reflect only indexed tags. This is a clean forward-only implementation.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.1 (frontend) + Rust integration tests (cargo test) |
| Config file | vite.config.ts (implied via package.json test script) |
| Quick run command | `npm test` (vitest run) |
| Full suite command | `npm test && cargo test --test db_tests -- --test-threads=1` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TREE-05 | search_nodes returns results with snippet for matching text | integration (Rust) | `cargo test --test db_tests test_search_nodes -- --test-threads=1` | Wave 0 |
| TREE-05 | SearchOverlay opens on Cmd+K, closes on Escape | unit (React) | `npm test -- SearchOverlay` | Wave 0 |
| EDIT-01 | undo_step rolls back last structural operation | integration (Rust) | `cargo test --test db_tests test_undo_redo -- --test-threads=1` | Wave 0 |
| EDIT-01 | text edit groups collapse by 1s gap | unit (Zustand) | `npm test -- undoGrouping` | Wave 0 |
| EDIT-02 | Bold/Italic/Code marks round-trip through JSON | unit (TipTap) | `npm test -- markFormatting` | Wave 0 |
| EDIT-03 | HashtagNode inserted by Suggestion command | unit (TipTap) | `npm test -- HashtagNode` | Wave 0 |
| EDIT-03 | node_tags table updated on content save | integration (Rust) | `cargo test --test db_tests test_tag_indexing -- --test-threads=1` | Wave 0 |
| EDIT-04 | Bullet renders sparkle icon for agent_response | unit (React) | `npm test -- Bullet` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm test && cargo test --test db_tests -- --test-threads=1`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/tests/db_tests.rs` — extend with: `test_search_nodes`, `test_undo_redo`, `test_tag_indexing`
- [ ] `src/components/Search/SearchOverlay.test.tsx` — Cmd+K open/close, keyboard navigation
- [ ] `src/extensions/HashtagNode.test.tsx` — node insertion, JSON round-trip
- [ ] `src/components/Outliner/Bullet.test.tsx` — sparkle icon for agent_response
- [ ] `src/utils/undoGrouping.test.ts` — 1s gap grouping logic

---

## Sources

### Primary (HIGH confidence)
- [SQLite FTS5 official docs](https://sqlite.org/fts5.html) — FTS5 CREATE syntax, snippet(), external content, triggers
- [TipTap Suggestion utility docs](https://tiptap.dev/docs/editor/api/utilities/suggestion) — char, items(), command(), render() API
- [TipTap Mark API docs](https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/mark) — Mark.create(), parseHTML, renderHTML, toggleMark
- [TipTap keyboard shortcuts docs](https://tiptap.dev/docs/editor/core-concepts/keyboard-shortcuts) — Cmd+B (bold), Cmd+I (italic), Cmd+E (code)
- [TipTap StarterKit docs](https://tiptap.dev/docs/editor/extensions/functionality/starterkit) — included marks, configure() options
- Codebase: `src/store/treeStore.ts`, `src/components/Outliner/NodeEditor.tsx`, `src-tauri/migrations/0001_initial_schema.sql` — verified existing patterns

### Secondary (MEDIUM confidence)
- [cmdk npm package](https://www.npmjs.com/package/cmdk) — version 1.1.1, zero dependencies, Command.Dialog API confirmed
- [SQLite FTS5 DeepWiki](https://deepwiki.com/sqlite/sqlite/5.1-full-text-search-5-(fts5)) — additional FTS5 configuration details

### Tertiary (LOW confidence)
- WebSearch results on undo/redo event sourcing patterns — snapshot approach verified as simpler than full event sourcing for this use case

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — TipTap v3 and SQLite FTS5 verified via official docs; cmdk version confirmed on npm
- Architecture: HIGH — patterns derived from official docs + existing codebase analysis
- Pitfalls: HIGH — FTS5/rowid mismatch and sqlx virtual table limitation verified via official SQLite docs and sqlx issue tracker

**Research date:** 2026-03-25
**Valid until:** 2026-04-25 (stable ecosystem; TipTap v3 API stable, FTS5 stable)
