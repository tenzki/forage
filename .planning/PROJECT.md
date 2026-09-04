# Forage — Outliner with Agent Support

## What This Is

Forage is a local-first, Workflowy-style infinite outliner with agents that can research, generate, and organize material inside any branch. The outline is the product's primary workspace: user notes, captured material, and agent results all become part of one editable document rather than separate chat sessions.

## Core Value

One durable outline serves as a shared working surface for the user and explicitly invoked or automated agents. Agents receive bounded, visible context and return structured outline content that participates in normal editing, persistence, synchronization, provenance, and undo.

## Product Capabilities

- Infinite nested bullet-point outline with stable node identity
- Zoom, breadcrumbs, expand/collapse, keyboard restructuring, drag/reorder, tags, and search
- Rich editing with durable undo and redo
- Slash-command skills that operate on branch-local and explicitly referenced context
- Configurable agents, skills, model selection, and bounded tool allowlists
- Local agent execution through an isolated Pi SDK sidecar
- Local-first SQLite persistence with checkpoints and crash-safe replay
- Optional self-hosted multi-device synchronization
- Plain-text capture into Inbox through a scoped server API
- Optional durable server agents and capture automation
- Content-addressed generated-image storage and transfer

## Current Boundaries

- **Desktop:** Tauri v2 with React, TypeScript, TipTap, and one ProseMirror document for the whole outline.
- **Native layer:** Custom bounded Rust commands own SQLite, local asset bytes, OS credential storage, and authenticated origin-pinned server transport.
- **Local persistence:** SQLite is authoritative in local mode. Immutable document operations and semantic events reconstruct the outline; checkpoints bound startup work.
- **Server persistence:** In optional server mode, PostgreSQL is authoritative while desktop SQLite remains the offline cache and pending outbox.
- **Local agents:** A Node.js sidecar embeds the Pi SDK and communicates with the frontend using bounded JSONL. It creates in-memory sessions and exposes only application-authorized context and tools.
- **Server agents:** A portable runtime executes durable PostgreSQL-backed jobs using enrolled encrypted credentials and commits results to the same event stream.
- **Model access:** Users provide an OpenAI API key or authorize a ChatGPT account. Forage does not operate hosted inference or silently upload desktop credentials to the optional server.
- **Assets:** Raster bytes live in content-addressed stores; documents and events contain verified SHA-256 references.

## Product Rules

- The ProseMirror document is the only authoritative outline model; persistence must not introduce a competing per-node representation.
- Stable bullet identity survives editing, movement, replay, synchronization, and internal links.
- Agent context is selected by the application from command placement and explicit stable-ID references, then bounded before execution.
- Agent output is validated structured content inserted through normal document transactions.
- Tool access is deny-by-default and is the intersection of global, agent, and skill policy.
- Local mode works without an account or network connection.
- Server mode is optional, self-hosted, and one-owner; synchronization conflicts are explicit rather than silently overwritten.
- Secrets remain behind native or server credential boundaries and never enter document events, prompts, URLs, or logs.

## Out of Scope

- Multi-user workspaces and shared editing
- Real-time collaborative cursors
- Managed Forage cloud hosting
- A standalone chat-session data model
- Mobile and web clients
- Automatic installation of untrusted third-party Pi packages or extensions
- Storing the live SQLite database or outline JSON in iCloud

## Key Decisions

| Decision | Current outcome |
| --- | --- |
| Desktop platform | Tauri and React/TipTap retained; see ADR-0011 |
| Outline model | One ProseMirror document with embedded stable identities; see ADR-0002 and ADR-0003 |
| Durability | Immutable local SQLite event stream, checkpoints, and optional PostgreSQL authority; see ADR-0012 |
| Synchronization | Optional self-hosted server with PostgreSQL authority and a durable desktop outbox |
| Local agent runtime | Pi SDK embedded in an isolated Node.js sidecar; see ADR-0013 |
| Agent context and tools | Explicit branch-local context and bounded declarative tools; see ADR-0006 and ADR-0007 |
| Subscription images | Isolated Codex app-server bridge retained; see ADR-0009 |
| Agent document integration | Stateless runs return structured nodes to the same ProseMirror document; no Pi session tree mapping |

The canonical component and authority map is [docs/architecture.md](../docs/architecture.md). Historical changes remain recorded in [docs/ADRs](../docs/ADRs).

---

*Last updated: 2026-09-04 — event store, optional server, durable agents, and embedded Pi SDK sidecar*
