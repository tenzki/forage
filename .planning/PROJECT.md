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
- Standalone chat app mode — deferred; v1 sends the selected outline branch to a stateless Pi run
- Managed cloud service — deferred, iCloud sync first
- Local/on-device LLM support — user API keys only for v1
- Mobile app — not planned

## Context

- Inspired by Workflowy's outliner UX and Pi agent's tree-based work organization
- TipTap remains the source of truth. A slash command starts a no-session Pi run using its full ancestor path and complete parent branch, excluding the command subtree and unrelated higher-level sibling branches, plus explicitly linked branches from stable internal references.
- Persisted skills are slash-command workflows assigned to persisted agent profiles. Context selection is an application rule determined by command placement and visible references; agents define instructions, model overrides, and tool allowlists.
- Slash commands (e.g., `/research concurrent companies for LambdaWorks`) are the primary agent interaction model, triggered from any node

## Constraints

- **Tech stack**: Tauri v2 shell (desktop target) with a TypeScript/React frontend. **No custom Rust backend in v1** — only official Tauri plugins. Agent work runs in a Pi JSONL RPC subprocess launched through the shell plugin; subscription images use Codex app-server, and production must bundle pinned Pi and Codex runtimes.
- **Data**: Local-first. Tree persisted as a single JSON file placed in the iCloud Drive folder; macOS handles sync. No custom sync engine.
- **Editor**: One ProseMirror/TipTap document for the whole outliner with a custom bullet node — not one editor per node. Chosen for undo/keyboard correctness.
- **LLM access**: User-owned ChatGPT subscription or OpenAI API key, no hosted inference. Credentials are passed to the local Pi process through its environment.
- **Target user**: Personal tool first, small team second. v1 ships as a shareable signed macOS .dmg.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Tauri for desktop | Lightweight vs Electron; desktop is the real target | — Kept |
| Local-first + iCloud sync | Place JSON file in iCloud Drive folder; macOS syncs it. No custom code | — Kept (simplified) |
| Tree as universal primitive | Enables reuse for chat app later without architectural rework | — Kept |
| Slash commands for agent | Inline UX keeps user in flow, no context switching to a chat panel | — Kept |
| User-provided API keys | No billing/auth infrastructure needed for v1; users paste own key | — Kept |
| Pi RPC subprocess as agent runtime | The old sidecar failed because agent work also crossed custom Rust IPC, SQLite, and a second session model. The re-platformed app can connect React directly to standard Pi RPC while keeping TipTap as the source of truth | — Adopted in ADR-0008; built-in tools/resources disabled and one app bridge extension explicitly loaded |
| ~~Custom Rust backend (SQLite + tauri-specta IPC)~~ | IPC type-drift, debounce-vs-IPC undo races. Only justified by a future shared server that v1 doesn't have | — **REVERSED**: logic moves to TypeScript; storage = single JSON file via plugin-fs |
| ~~1:1 tree mapping with Pi sessions~~ | Coupled the data model to Pi's session abstraction | — **REVERSED**: tree is plain data; agent context is the command's ancestor path and parent branch plus explicit stable-ID references resolved from TipTap at call time |
| Single-document editor | One ProseMirror doc with bullet nodes (Workflowy model). ProseMirror's native history fixes undo in one layer instead of Rust history + Zustand wrapper + disabled TipTap history | — New |

---
*Last updated: 2026-08-17 — Pi RPC agents, configurable skills, and bounded bridge tools*
