# Project Research Summary

**Project:** ai-chat
**Domain:** Tree-based note-taking / infinite outliner with embedded AI agent — Tauri desktop app (macOS)
**Researched:** 2026-03-24
**Confidence:** MEDIUM-HIGH

## Executive Summary

This is a Workflowy-style infinite outliner desktop app built on Tauri v2, differentiated by embedded AI agent capabilities triggered via slash commands. The core product is a local-first tree of notes with full keyboard control, zoom-into-node navigation, and iCloud Drive sync — a well-understood domain with established patterns. The differentiating layer is a configurable AI agent system where `/research`, `/expand`, and custom skill commands generate structured child nodes from branch context, using user-provided API keys (BYOK). Research confirms this combination is achievable with the Tauri v2 ecosystem, though one architectural decision — how to run the Vercel AI SDK inside a desktop app that cannot run Node.js in its WebView — requires deliberate upfront commitment to a Node.js sidecar pattern.

The recommended approach centers on four technology bets that compound well: react-arborist for the virtualized outliner tree, TipTap for node editing with slash command detection, SQLite via sqlx in Rust for local-first storage, and the Vercel AI SDK running inside a bundled Node.js sidecar binary for LLM integration. The iCloud sync story is handled by placing the SQLite file in the iCloud Drive folder and using NSFileCoordinator for safe concurrent access — no CloudKit API required. The architecture follows a strict frontend-IPC-Rust layering: all state lives in Zustand on the frontend, all persistence and AI calls happen in Rust, and the IPC boundary is typed via tauri-specta to prevent runtime mismatches.

The primary risks are not in the outliner core (well-documented) but in the intersection of iCloud file sync and SQLite. Direct SQLite placement inside an iCloud Drive container without proper file coordination will corrupt databases silently on multi-device usage — this is the single highest-severity pitfall and must be addressed in the storage foundation phase before any feature work begins. Secondary risks include: agent context window management (naive full-tree serialization hits token limits quickly), streaming LLM output without a cancellation mechanism, undo/redo integration with AI-generated batch operations, and macOS sandbox entitlements blocking HTTP calls in notarized builds. All are preventable with early architectural decisions.

---

## Key Findings

### Recommended Stack

The stack is anchored on Tauri 2.10.3 (Rust backend + WebView frontend) with React 19, TypeScript 5.x, and Vite 6.x. State management uses Zustand 5.x for synchronous UI state and TanStack Query 5.x for async IPC calls. The tree component is react-arborist 3.4.3 (virtualized, drag-and-drop, keyboard navigation included). Node editing uses TipTap 2.x for its first-class slash command support via `@tiptap/suggestion`. Data persistence uses SQLite via sqlx in Rust with Drizzle ORM in proxy mode for type-safe schema management on the frontend side.

The most architecturally significant decision is running the Vercel AI SDK (which requires Node.js) inside a Tauri app. The solution is a Node.js sidecar: a Node.js process compiled to a binary via `pkg`, spawned by Rust on startup, communicating via stdin/stdout JSON. This gives full AI SDK agentic capabilities including multi-step tool loops. The alternative (direct WebView `fetch()` to LLM APIs) works for basic generation but cannot support the agentic slash command system that is the product's differentiator.

**Core technologies:**
- Tauri 2.10.3: Desktop shell — Rust backend gives native system access, WebView renders React UI
- React 19 + Vite 6.x: Frontend framework and build tool — official Tauri template pairing
- react-arborist 3.4.3: Virtualized tree component — handles 10,000+ nodes, built-in DnD and keyboard nav
- TipTap 2.x: Node editor — headless ProseMirror with first-class slash command extension
- Zustand 5.x: Frontend state — minimal boilerplate, no provider tree, maps cleanly to single-window app
- SQLite via sqlx (Rust): Local storage — adjacency list tree model, WAL mode, FTS5 for search
- Drizzle ORM (proxy mode): Type-safe schema and migrations over tauri-plugin-sql IPC bridge
- tauri-specta 2.0.0-rc.21: Generates TypeScript bindings from Rust commands — prevents IPC boundary bugs
- Vercel AI SDK 6.x (Node.js sidecar): Provider-agnostic LLM integration with agent tool loops
- `@ai-sdk/openai` + `@ai-sdk/anthropic`: Runtime-configurable provider adapters for BYOK model

### Expected Features

The core outliner is table stakes: infinite nesting, zoom/hoist into node (with breadcrumb trail back to root), expand/collapse with persisted state, full keyboard navigation (Tab/Shift-Tab indent, Enter new sibling, Alt+Arrow move), global search, hashtag tagging, undo/redo for structural and text operations, drag-to-reorder, and local-first persistence. These are what users assume an outliner has — missing any of them makes the product feel incomplete.

The differentiating layer is the AI agent system: slash commands triggering configurable skills, agent-generated child nodes assembled from branch context, BYOK API key management, and configurable skill definitions. Tana is the closest competitor with AI integration, but it uses a managed cloud model. This product targets the Obsidian-proven market segment: local-first, user-controlled, no subscription required.

**Must have (v1 launch):**
- Infinite nested tree with expand/collapse
- Zoom/hoist into node with breadcrumb trail — without this it is not a real outliner
- Full keyboard navigation — Tab/Shift-Tab, Enter, Alt+Arrow, delete
- Global search across all nodes
- Undo/redo for structural and text operations
- Local-first persistence (SQLite)
- User API key configuration (OpenAI, Anthropic)
- Slash command trigger parsed from node content
- Agent generates child nodes using branch context
- Built-in research skill (validates skill model)
- iCloud sync — needed for daily driver adoption

**Should have (v1.x post-validation):**
- Configurable custom skills (custom system prompts)
- Agent inline content generation (write into current node)
- Hashtag filtering in search
- Inline Markdown rendering
- Multiple built-in skills

**Defer to v2+:**
- Chat/conversation tree mode (data model groundwork in v1)
- Wiki-style `[[links]]` between nodes
- Plugin/skill API
- Graph view
- Team collaboration (incompatible with iCloud sync architecture)

**Anti-features to avoid:** Graph view, bidirectional links, daily notes mode, real-time collaboration, plugin system, AI that autonomously reorganizes tree. All were researched and found to add complexity without proportional v1 value.

### Architecture Approach

The architecture is a strict three-layer system: React frontend (WebView) communicating with a Rust backend via Tauri IPC (`invoke`/`listen`), with a Node.js sidecar process for LLM calls. The frontend holds only UI state in Zustand stores — it never holds a database connection or makes network calls. All persistence, file I/O, and external API calls happen in Rust. The IPC boundary is typed via tauri-specta, eliminating runtime mismatches.

The tree is stored as an adjacency list with fractional indexing for sibling ordering — each node has a UUID primary key, a nullable `parent_id` foreign key, and a `position REAL` column. SQLite's `WITH RECURSIVE` CTE handles subtree reads. Agent streaming uses the Command+Event pattern: a `run_skill` command returns a `runId` immediately, the Rust async task streams tokens via `app.emit("agent:{runId}:token", ...)`, and the frontend subscribes by runId.

**Major components:**
1. Tree View (React + react-arborist + Zustand treeStore) — renders infinite nested nodes, handles keyboard nav and DnD
2. Node Editor (TipTap + useSlashDetect hook) — contenteditable node with slash command detection
3. Tauri IPC layer (tauri-specta typed commands) — tree CRUD, agent runner, settings management
4. Rust Tree Commands (sqlx + db module) — thin wrappers that delegate to pure db/agent functions
5. Agent Runner (Rust + reqwest streaming) — loads skill config, builds branch context, calls LLM, emits events
6. SQLite storage (sqlx, WAL mode, FTS5) — single .db file placed in iCloud-managed directory
7. Sync Manager (Rust notify crate + NSFileCoordinator) — watches iCloud folder, invalidates DB pool on file change
8. Node.js sidecar (Vercel AI SDK, compiled via pkg) — handles LLM provider calls, agent tool loops

### Critical Pitfalls

1. **SQLite + iCloud Drive file corruption** — Never place an active SQLite database directly in the iCloud container while open for writes. Use `NSFileCoordinator` for all writes; WAL sidecar files must be managed carefully or the database image becomes malformed. Must be addressed in the storage foundation phase before any feature work.

2. **Positional node IDs instead of stable UUIDs** — If node identity is based on array position or path strings, any concurrent edit or sync merge will silently corrupt the tree. Assign permanent UUIDs at creation and use fractional indexing for sibling order. Must be decided in the data model phase before any UI is built.

3. **Agent context sending the full tree** — Naively serializing the full tree as LLM context hits token limits and degrades output quality. Scope context to: triggered node + ancestors to root + immediate children. Configurable depth, explicit override for broad-scope skills. Token count assertion in tests.

4. **LLM streaming without cancellation** — Tauri's WebView cannot stream HTTP responses natively. All LLM calls must go through Rust via `reqwest` byte streaming + Tauri events. Must implement per-task cancellation tokens in a `HashMap<TaskId, CancellationToken>` and expose a `cancel_generation` command. Never write partial AI output to canonical nodes.

5. **macOS sandbox entitlements blocking iCloud and HTTP** — For Mac App Store distribution, sandbox entitlements must be configured for both the main binary and all helper processes. Missing `com.apple.security.network.client` silently blocks all Rust HTTP calls in notarized builds. Test with hardened runtime locally before submission.

---

## Implications for Roadmap

Research identifies a clear dependency graph that dictates build order. The outliner core must be solid before any AI features are layered on top. The iCloud sync architecture decision must be made before a single node is stored. The agent system has an internal dependency chain (skills → context builder → LLM runner → streaming UI) that cannot be parallelized.

### Phase 1: Data Model and Storage Foundation

**Rationale:** Everything depends on stable node storage. The highest-severity pitfall (SQLite + iCloud corruption) must be addressed here before any other work begins. UUID assignment, fractional indexing, and WAL mode are not retrofittable.
**Delivers:** SQLite schema with UUID nodes and fractional indexing, Rust CRUD commands, Drizzle ORM schema and migrations, iCloud Drive file placement with NSFileCoordinator wiring, tauri-specta typed IPC bindings
**Addresses:** Local-first persistence (table stakes), iCloud sync foundation
**Avoids:** SQLite corruption pitfall, tree ID instability pitfall, API key plaintext storage pitfall (keychain setup here)
**Research flag:** NEEDS DEEPER RESEARCH — NSFileCoordinator integration in Rust/Tauri is not well-documented; sparse official guidance for this specific pairing

### Phase 2: Core Outliner UI

**Rationale:** The outliner tree is the product. Build it to Workflowy quality before adding any AI features. React-arborist handles most of the hard work; keyboard shortcuts and zoom/breadcrumb are the integration challenges.
**Delivers:** Infinite nested tree with expand/collapse, zoom/hoist into node with breadcrumb trail, full keyboard navigation (Tab/Shift-Tab/Enter/Alt+Arrow), drag-to-reorder, persist collapse and zoom state across sessions
**Uses:** react-arborist 3.4.3, TipTap 2.x, Zustand treeStore + editorStore, TanStack Query for async IPC
**Implements:** Tree View, Node Editor, BreadcrumbBar components; treeStore, editorStore
**Research flag:** STANDARD PATTERNS — react-arborist is well-documented; keyboard nav patterns are established; no additional research needed

### Phase 3: Search and Data Integrity

**Rationale:** Search is mandatory once the tree exceeds ~50 nodes. Undo/redo architecture must be established before agent is wired in — retrofitting undo to cover AI batch operations is a known pitfall.
**Delivers:** Global search with SQLite FTS5, hashtag parsing, undo/redo covering structural operations (not just text), undo architecture designed to accept batch operations (needed for Phase 5)
**Implements:** FTS5 virtual table, search command, undo manager with batch operation support
**Avoids:** Undo/redo breaks across AI-generated content pitfall (established here, before agent integration)
**Research flag:** STANDARD PATTERNS — SQLite FTS5 is well-documented; undo manager patterns for outliners are established

### Phase 4: Agent Infrastructure

**Rationale:** The agent system has multiple internal dependencies that must be built in order: skills config loader → context builder → LLM runner → streaming event system. Attempting to build these concurrently creates integration chaos.
**Delivers:** TOML-based skill definitions, branch context extraction with configurable scope depth, Node.js sidecar wired to Tauri backend, LLM streaming via Tauri events, per-task cancellation mechanism, agentStore + useAgentStream hook
**Uses:** Vercel AI SDK 6.x in Node.js sidecar, `@ai-sdk/openai` + `@ai-sdk/anthropic`, reqwest streaming in Rust
**Avoids:** Agent context token explosion pitfall, streaming without cancellation pitfall
**Research flag:** NEEDS DEEPER RESEARCH — Node.js sidecar + pkg compilation for Tauri distribution is a niche pattern; sidecar binary signing and notarization on macOS needs validation

### Phase 5: Slash Command UI and Built-in Skills

**Rationale:** User-facing AI features are layered on top of the agent infrastructure from Phase 4. Slash command detection and the autocomplete overlay are UI concerns that can now be cleanly wired to the agent runner.
**Delivers:** Slash command trigger (only when `/` is first non-whitespace in node), autocomplete overlay via shadcn/ui Popover, built-in "research" skill, streaming ghost placeholder nodes during generation, user API key settings panel, error translation layer (human-readable LLM errors)
**Implements:** SlashMenu.tsx, AgentStatus.tsx, ApiKeys.tsx, SkillsConfig.tsx
**Avoids:** Accidental slash command trigger (guard: first non-whitespace char), API key plaintext storage (keychain via tauri-plugin-keyring)
**Research flag:** STANDARD PATTERNS — TipTap slash command extension is officially documented; shadcn/ui command palette is standard

### Phase 6: iCloud Sync Completion and Distribution

**Rationale:** Sync is deferred to last to avoid it interfering with development of core features. The file placement and NSFileCoordinator wiring from Phase 1 is the foundation; Phase 6 adds the sync status UI, conflict resolution handling, and App Store distribution packaging.
**Delivers:** Sync status badge (syncing/synced/conflict), NSFilePresenter implementation for conflict notification, conflict resolution UI (merge-both default strategy), zoom state persistence across restarts, macOS sandbox entitlements configuration for App Store submission, notarization pipeline
**Avoids:** iCloud conflict resolution silent data loss pitfall, Tauri sandbox entitlements blocking iCloud+HTTP pitfall
**Research flag:** NEEDS DEEPER RESEARCH — NSFilePresenter in Rust/Tauri has sparse documentation; conflict resolution UX for tree data is domain-specific; Mac App Store submission with iCloud entitlements needs hands-on validation

### Phase Ordering Rationale

- Phase 1 before everything: UUID node identity and iCloud file placement cannot be retrofitted after data exists
- Phases 2-3 before AI (Phases 4-5): The outliner must work without AI to validate the core product; also undo architecture must be established before agent generates content
- Phase 4 before Phase 5: Agent infrastructure (sidecar, streaming, cancellation) is a prerequisite for the slash command UI
- Phase 6 last: Sync and distribution are the final integration concerns; keeping them separate from feature development prevents sync edge cases from slowing down core development

### Research Flags

Phases likely needing deeper `/gsd:research-phase` during planning:
- **Phase 1 (Storage):** NSFileCoordinator integration in Rust has sparse official documentation for the Tauri-specific pattern; iCloud Drive path setup on macOS needs hands-on validation
- **Phase 4 (Agent Infrastructure):** Node.js sidecar compilation via `pkg` and macOS notarization of sidecar binaries is a niche pattern; the stdin/stdout JSON protocol design needs upfront specification
- **Phase 6 (Sync + Distribution):** NSFilePresenter in Rust (requires objc crate or Swift interop), iCloud entitlements for App Store, conflict resolution UX for tree data

Phases with well-documented standard patterns (skip or lightweight research):
- **Phase 2 (Core Outliner UI):** react-arborist, TipTap, Zustand patterns are thoroughly documented
- **Phase 3 (Search + Undo):** SQLite FTS5 is standard; undo manager patterns for outliners are established
- **Phase 5 (Slash Commands):** TipTap suggestion extension is officially documented; shadcn/ui command palette is a standard component

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Core stack (Tauri, React, react-arborist, TipTap, SQLite) verified against official sources and community templates. Node.js sidecar pattern confirmed by Tauri official docs. |
| Features | HIGH (core outliner), MEDIUM (AI agent) | Outliner feature set is established and competitor-validated. AI agent patterns are newer — slash command + child node generation is a product bet, not an industry standard. |
| Architecture | MEDIUM-HIGH | Adjacency list tree, Command+Event streaming, and three-layer IPC are well-established. NSFileCoordinator in Rust and sidecar-to-backend communication protocol are less documented. |
| Pitfalls | MEDIUM | SQLite + iCloud corruption and UUID stability are well-sourced. Tauri sandbox + iCloud entitlement pitfall is confirmed by a real GitHub issue. Context window and streaming pitfalls are common LLM application patterns. |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **NSFileCoordinator in Rust:** Apple's `NSFileCoordinator` APIs require either the `objc` crate or a Swift helper process. The exact Tauri-compatible implementation pattern is not documented. Needs a proof-of-concept spike in Phase 1.
- **Node.js sidecar notarization:** Bundling a `pkg`-compiled Node.js binary inside a Tauri `.app` and getting it through Apple notarization (code signing requirements for embedded binaries) is a known friction point with limited documentation. Must be validated before Phase 4 completes.
- **Drizzle proxy driver stability:** Drizzle ORM's proxy driver for Tauri (routing through `invoke` rather than direct FS access) is documented in community posts but not in Drizzle's official docs. Validate early in Phase 1.
- **iCloud sync on iOS (future):** Research focused on macOS. If iOS support is added later, `NSFileCoordinator` approach differs from macOS and iCloud sync behaviors differ. Out of scope for v1 but worth noting.
- **AI SDK sidecar stdin/stdout protocol:** The specific JSON protocol for communicating streaming tokens between the Rust backend and the Node.js sidecar needs design. No official reference implementation exists for this exact pattern.

---

## Sources

### Primary (HIGH confidence)
- https://v2.tauri.app/learn/sidecar-nodejs/ — Node.js sidecar pattern, official Tauri docs
- https://github.com/tauri-apps/tauri/releases — Tauri 2.10.3 version verified
- https://ai-sdk.dev/docs/introduction — Vercel AI SDK v6, Node.js requirement confirmed
- https://github.com/specta-rs/tauri-specta — tauri-specta v2.0.0-rc.21 feature set
- https://github.com/brimdata/react-arborist — react-arborist 3.4.3 API and virtualization
- https://tiptap.dev/docs/examples/experiments/slash-commands — TipTap slash command support
- https://ui.shadcn.com/docs/tailwind-v4 — shadcn/ui + Tailwind v4 compatibility
- https://www.sqlite.org/wal.html — SQLite WAL mode documentation
- https://www.sqlite.org/howtocorrupt.html — SQLite corruption causes confirmed

### Secondary (MEDIUM confidence)
- https://dev.to/huakun/drizzle-sqlite-in-tauri-app-kif — Drizzle proxy driver pattern for Tauri
- https://github.com/dannysmith/tauri-template — Zustand + TanStack Query community template pattern
- https://github.com/vercel/ai/issues/7499 — MCP + Tauri sidecar pattern discussion
- https://zottmann.org/2025/09/08/ios-icloud-drive-synchronization-deep.html — iCloud Drive sync deep dive
- https://fatbobman.com/en/posts/in-depth-guide-to-icloud-documents/ — NSFileCoordinator guide
- https://developer.apple.com/library/archive/technotes/tn2336/_index.html — Apple TN2336: iCloud conflict handling
- https://github.com/tauri-apps/tauri/issues/13878 — Tauri sandbox blocking network in production builds (confirmed bug)
- https://factory.ai/news/context-window-problem — LLM context window scaling

### Tertiary (LOW confidence)
- https://blog.saner.ai/best-workflowy-alternatives/ — Competitor feature comparison
- https://blog.knowing.app/posts/best-ai-outliner-app-2025/ — AI outliner market survey
- https://molodtsov.me/2020/07/outliners/ — Historical outliner analysis (dated, context only)

---
*Research completed: 2026-03-24*
*Ready for roadmap: yes*
