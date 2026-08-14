# AI Chat — Tree-Based Note-Taking with AI Agent

## What This Is

A Workflowy-style infinite outliner with an embedded AI agent that can generate and organize notes within any branch of the tree. Built as a Tauri desktop app with a Rust backend, local-first storage with iCloud sync. The tree structure serves as a universal primitive — notes today, chat conversations tomorrow.

## Core Value

The tree is the universal data structure — every note, conversation, and piece of generated content lives as a node in an infinite nested tree, and an AI agent can operate on any branch using configurable skills.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Infinite nested bullet-point tree (Workflowy-style)
- [ ] Zoom into any node (node becomes the "root" view)
- [ ] Keyboard-driven navigation and editing
- [ ] Search across all nodes
- [ ] Expand/collapse branches
- [ ] Slash commands within notes to trigger agent actions
- [ ] Agent generates child notes using branch context
- [ ] Agent generates inline data on current note
- [ ] Configurable LLM agent skills (research, design/brand guidelines, etc.)
- [ ] User provides their own API keys (OpenAI, Anthropic, etc.)
- [ ] Local-first data storage
- [ ] iCloud sync

### Out of Scope

- Web app — deferred to post-v1
- Team collaboration / multi-user — deferred to post-v1
- Standalone chat app mode — deferred, but the 1:1 tree mapping with Pi sessions means chat is inherent to the architecture from v1
- Managed cloud service — deferred, iCloud sync first
- Local/on-device LLM support — user API keys only for v1
- Mobile app — not planned

## Context

- Inspired by Workflowy's outliner UX and Pi agent's tree-based work organization
- The outliner tree and Pi's session tree are 1:1 mapped — each outliner branch IS a Pi session branch. Notes and conversations live in the same tree structure. When a slash command is issued, it branches a Pi session from that node, with ancestors as conversation context
- Skills are LLM agent capabilities configured per-workspace or per-branch — e.g., a "research" skill that knows how to investigate a topic and structure findings as child notes
- Slash commands (e.g., `/research concurrent companies for LambdaWorks`) are the primary agent interaction model, triggered from any node

## Constraints

- **Tech stack**: Tauri v2 shell (desktop target) with a TypeScript/React frontend. **No custom Rust backend in v1** — only official Tauri plugins (fs, store, shell). LLM calls go directly from the frontend via `@anthropic-ai/sdk`. No Node.js sidecar.
- **Data**: Local-first. Tree persisted as a single JSON file placed in the iCloud Drive folder; macOS handles sync. No custom sync engine.
- **Editor**: One ProseMirror/TipTap document for the whole outliner with a custom bullet node — not one editor per node. Chosen for undo/keyboard correctness.
- **LLM access**: User-provided API keys, no hosted inference. Anthropic only in v1.
- **Target user**: Personal tool first, small team second. v1 ships as a shareable signed macOS .dmg.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Tauri for desktop | Lightweight vs Electron; desktop is the real target | — Kept |
| Local-first + iCloud sync | Place JSON file in iCloud Drive folder; macOS syncs it. No custom code | — Kept (simplified) |
| Tree as universal primitive | Enables reuse for chat app later without architectural rework | — Kept |
| Slash commands for agent | Inline UX keeps user in flow, no context switching to a chat panel | — Kept |
| User-provided API keys | No billing/auth infrastructure needed for v1; users paste own key | — Kept |
| ~~Pi agent SDK as agent runtime~~ | Introduced a third runtime (Node.js sidecar, 52 MB binary, JSON-RPC) and an unfamiliar agent abstraction. Every feature crossed React↔Zustand↔IPC↔Rust↔SQLite↔sidecar — 6 seams. Caused the API-key (0-byte binary), slash-command, and undo bug clusters | — **REVERSED**: replaced by `@anthropic-ai/sdk` called directly from frontend |
| ~~Custom Rust backend (SQLite + tauri-specta IPC)~~ | IPC type-drift, debounce-vs-IPC undo races. Only justified by a future shared server that v1 doesn't have | — **REVERSED**: logic moves to TypeScript; storage = single JSON file via plugin-fs |
| ~~1:1 tree mapping with Pi sessions~~ | Coupled the data model to Pi's session abstraction | — **REVERSED**: tree is plain data; agent context built from ancestors at call time |
| Single-document editor | One ProseMirror doc with bullet nodes (Workflowy model). ProseMirror's native history fixes undo in one layer instead of Rust history + Zustand wrapper + disabled TipTap history | — New |

---
*Last updated: 2026-06-08 — re-platform: drop Pi sidecar + custom Rust, keep Tauri shell, single-doc editor*
