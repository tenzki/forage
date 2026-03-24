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
- Chat app mode (tree = conversation) — future milestone, architecture should accommodate
- Managed cloud service — deferred, iCloud sync first
- Local/on-device LLM support — user API keys only for v1
- Mobile app — not planned

## Context

- Inspired by Workflowy's outliner UX and Pi agent's tree-based work organization
- The tree structure is designed to be reusable as a chat interface later (each branch = a conversation thread)
- Skills are LLM agent capabilities configured per-workspace or per-branch — e.g., a "research" skill that knows how to investigate a topic and structure findings as child notes
- Slash commands (e.g., `/research concurrent companies for LambdaWorks`) are the primary agent interaction model, triggered from any node

## Constraints

- **Tech stack**: Tauri (Rust backend + web frontend), Rust for server component
- **Data**: Local-first architecture, iCloud for sync in v1
- **LLM access**: User-provided API keys, no hosted inference
- **Target user**: Personal tool first, small team second

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Tauri for desktop | Rust backend aligns with server reuse, lightweight vs Electron | — Pending |
| Local-first + iCloud sync | Simplest sync for personal use, avoids managed infra in v1 | — Pending |
| Tree as universal primitive | Enables reuse for chat app later without architectural rework | — Pending |
| Slash commands for agent | Inline UX keeps user in flow, no context switching to a chat panel | — Pending |
| User-provided API keys | No billing/auth infrastructure needed for v1 | — Pending |

---
*Last updated: 2026-03-24 after initialization*
