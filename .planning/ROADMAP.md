# Roadmap: AI Chat — Tree-Based Note-Taking with AI Agent

## Overview

Six phases building from the ground up: a stable storage foundation first, then the full outliner experience, then editing completeness with undo, then the agent infrastructure, then user-facing AI skills, and finally iCloud sync completion and distribution. The order is non-negotiable — the storage schema and iCloud file placement cannot be retrofitted, undo must exist before AI generates content, and the agent sidecar must exist before the slash command UI.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Storage Foundation** - SQLite schema, UUID node identity, Tauri IPC layer, iCloud file placement (completed 2026-03-24)
- [x] **Phase 2: Core Outliner** - Infinite nested tree, zoom/hoist, keyboard navigation, drag-to-reorder (completed 2026-03-24)
- [x] **Phase 3: Search and Editing** - Global search, undo/redo, Markdown formatting, hashtags, AI content styling (completed 2026-03-25)
- [ ] **Phase 4: Agent Infrastructure** - API key management, Node.js sidecar, LLM streaming, slash command core
- [ ] **Phase 5: Skills and Agent UI** - Built-in research skill, custom skill configuration, slash command overlay
- [ ] **Phase 6: iCloud Sync and Distribution** - Sync status, conflict resolution, macOS entitlements, notarization

## Phase Details

### Phase 1: Storage Foundation
**Goal**: A stable, corruption-safe local data layer that the entire app can build on
**Depends on**: Nothing (first phase)
**Requirements**: INFR-02, INFR-04
**Success Criteria** (what must be TRUE):
  1. App stores nodes in SQLite and they survive app restarts with all content and hierarchy intact
  2. Node identity uses stable UUIDs with fractional indexing — no positional IDs that break on reorder
  3. SQLite file is placed in the iCloud Drive folder so iCloud handles sync automatically
  4. Data model includes a `node_type` column distinguishing user notes from agent responses, compatible with Pi's tree session structure (1:1 mapping between outliner nodes and Pi session branches)
  5. All IPC commands are typed end-to-end via tauri-specta — no runtime type mismatches at the IPC boundary
**Plans:** 2/2 plans complete

Plans:
- [x] 01-01-PLAN.md — Scaffold Tauri v2 project, SQLite schema, Rust models, DB initialization
- [x] 01-02-PLAN.md — IPC command handlers, tauri-specta bindings, integration tests

### Phase 2: Core Outliner
**Goal**: Users can work in a fast, fully keyboard-driven infinite outliner that feels like Workflowy
**Depends on**: Phase 1
**Requirements**: TREE-01, TREE-02, TREE-03, TREE-04, TREE-06
**Success Criteria** (what must be TRUE):
  1. User can create nodes nested to any depth and the tree renders without performance degradation at 1000+ nodes
  2. User can zoom into any node so it becomes the root view, with a breadcrumb trail showing the path back
  3. User can navigate and restructure the entire tree without touching the mouse: Tab/Shift-Tab to indent, Enter for new sibling, Alt+Arrow to move, Delete to remove
  4. User can expand and collapse any branch and that state persists across app restarts
  5. User can drag a node to reorder it or re-nest it under a different parent
**Plans:** 3/3 plans complete

Plans:
- [ ] 02-01-PLAN.md — React setup, move_node backend IPC, Vitest, tree helper utilities with tests
- [ ] 02-02-PLAN.md — Zustand store, OutlinerView, NodeRow, Bullet, Breadcrumb, expand/collapse, zoom/hoist
- [ ] 02-03-PLAN.md — TipTap NodeEditor, keyboard shortcuts, drag-and-drop

### Phase 3: Search and Editing
**Goal**: Users can find any node instantly and have a complete, undo-safe editing experience
**Depends on**: Phase 2
**Requirements**: TREE-05, EDIT-01, EDIT-02, EDIT-03, EDIT-04
**Success Criteria** (what must be TRUE):
  1. User can search across all nodes and see results with surrounding context, navigable without leaving keyboard
  2. User can undo and redo any structural operation (indent, move, delete) and any text edit as a single action
  3. User can use bold, italic, and inline code Markdown formatting within node text
  4. User can tag nodes with #hashtags by typing them inline, and tagged nodes are visually distinguished
  5. AI-generated content is visually styled differently from user-written content so the user always knows what the agent wrote
**Plans:** 4/4 plans complete

Plans:
- [ ] 03-01-PLAN.md — Database migration (FTS5, undo, tags), Rust search backend, Cmd+K overlay
- [ ] 03-02-PLAN.md — Persistent undo/redo Rust backend + Zustand store wrapper
- [ ] 03-03-PLAN.md — Hashtag TipTap extension, autocomplete, tag sidebar
- [ ] 03-04-PLAN.md — Markdown formatting CSS, AI sparkle icon, context menu

### Phase 4: Agent Infrastructure
**Goal**: Pi agent SDK embedded as Node.js sidecar, wired to Tauri IPC — slash commands trigger Pi skills that stream results into the tree
**Depends on**: Phase 3
**Requirements**: INFR-01, AGNT-01, AGNT-02, AGNT-03
**Tech decision**: Pi agent SDK (`@mariozechner/pi-coding-agent`) replaces custom Vercel AI SDK + sidecar. Pi provides multi-model support (15+ providers), streaming, skills, and tree-structured sessions out of the box.
**Success Criteria** (what must be TRUE):
  1. Pi agent SDK runs as a Node.js sidecar within Tauri, communicating via RPC (JSON over stdin/stdout)
  2. Outliner tree nodes map 1:1 to Pi session branches — slash command from a node creates/continues a Pi session branch at that position
  3. User can configure API keys through Pi's built-in model configuration
  4. User can type a slash command in any node and it triggers a Pi skill without false positives on slashes mid-sentence
  5. Agent generates structured child notes under the triggered node using ancestors as Pi session context
  6. Agent-generated content streams into the tree in real time with a ghost/placeholder node visible during generation
  7. User can cancel an in-progress generation cleanly
**Plans**: TBD

### Phase 5: Skills and Agent UI
**Goal**: Users can run the built-in research skill out of the box and configure their own custom skills using Pi's skill/extension system
**Depends on**: Phase 4
**Requirements**: AGNT-04, AGNT-05
**Success Criteria** (what must be TRUE):
  1. User can type `/research [topic]` in any node and receive structured research findings as child nodes without any configuration
  2. User can create a custom skill using Pi's skill format (instructions + tools) — it then appears in the slash command menu
  3. User can edit or delete custom skills from a skills configuration panel
  4. Agent can generate inline content on the current node (not just child notes) when the skill calls for it
**Plans**: TBD

### Phase 6: iCloud Sync and Distribution
**Goal**: The app syncs reliably across the user's devices by placing data in the iCloud Drive folder, and can be distributed as a signed, notarized macOS app
**Depends on**: Phase 5
**Requirements**: INFR-03
**Success Criteria** (what must be TRUE):
  1. SQLite database stored in iCloud Drive folder — iCloud handles file sync automatically
  2. Changes made on one Mac appear on a second Mac after iCloud sync completes
  3. App passes macOS notarization with hardened runtime enabled, including the Node.js sidecar binary
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Storage Foundation | 2/2 | Complete   | 2026-03-24 |
| 2. Core Outliner | 3/3 | Complete   | 2026-03-24 |
| 3. Search and Editing | 4/4 | Complete   | 2026-03-25 |
| 4. Agent Infrastructure | 0/TBD | Not started | - |
| 5. Skills and Agent UI | 0/TBD | Not started | - |
| 6. iCloud Sync and Distribution | 0/TBD | Not started | - |

---
*Roadmap created: 2026-03-24*
