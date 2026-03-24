# Stack Research

**Domain:** Tauri desktop app — tree-based note-taking with AI agent integration
**Researched:** 2026-03-24
**Confidence:** MEDIUM-HIGH (core stack HIGH, LLM integration in Tauri MEDIUM due to architectural decision required)

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Tauri | 2.10.3 | Desktop app shell (Rust backend + WebView frontend) | Project constraint. Lighter than Electron, Rust aligns with backend reuse, native system APIs. Stable v2 since Oct 2024. |
| React | 19 | Frontend UI framework | Dominant choice in Tauri templates, best ecosystem for tree/editor components, hooks model maps cleanly to outliner state. |
| TypeScript | 5.x | Type-safe frontend and tooling | Type safety across IPC boundary is essential — tauri-specta generates TS types from Rust commands. |
| Vite | 6.x | Frontend build tool | Official Tauri recommendation for SPA/React, fast HMR during development, no config ceremony. |
| Rust (stable) | 1.85+ | Tauri backend, file I/O, SQLite access | Required by Tauri. Handles file system ops, SQLite queries, sidecar process management. |

### State Management

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Zustand | 5.x | Global UI state (tree selection, expanded nodes, active agent runs) | Minimal boilerplate, hook-based API, no provider tree needed. Standard in Tauri community templates. Handles single-window state cleanly. |
| TanStack Query | 5.x | Async data fetching / cache (node loading, search results) | Manages async Tauri `invoke` calls with caching and loading states. Avoids manual cache invalidation for tree node reads. |

### UI Layer

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Tailwind CSS | 4.x | Utility-first styling | Current standard, v4 is stable and shipped in modern Tauri templates alongside shadcn/ui. |
| shadcn/ui | latest | Headless component primitives (dialogs, dropdowns, command palette) | Unstyled primitives that compose well without fighting a design system. Used in most production Tauri templates. |
| react-arborist | 3.4.3 | Virtualized tree view with drag-drop, inline rename, keyboard nav | Best-in-class for Workflowy-style outliners. Virtualized (handles 10,000+ nodes), built-in DnD, inline editing, keyboard navigation — exactly what's needed. Actively maintained. |
| TipTap | 2.x | Rich text editing within each node | Headless editor built on ProseMirror. First-class slash command support via `@tiptap/suggestion`. Avoids building a text editor from scratch while staying customizable. |

### Data Persistence

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| tauri-plugin-sql | 2.x | Frontend-to-SQLite IPC bridge | Official Tauri plugin. Routes frontend SQL calls to Rust/sqlx. Standard for Tauri SQLite apps. |
| Drizzle ORM (proxy mode) | 0.39+ | Type-safe schema definition and migrations on top of tauri-plugin-sql | Drizzle's proxy driver routes SQL queries through `invoke` rather than direct file access (required in WebView). Migrations inlined at build time via `import.meta.glob`. Active 2025-2026 ecosystem support. |
| SQLite (via sqlx in Rust) | 3.x | Local storage engine | Local-first requirement. Relational model handles tree nodes as rows with parent_id FK and position ordering naturally. |

### Rust–TypeScript Type Safety

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| tauri-specta | 2.0.0-rc.21 | Generate TypeScript bindings from Rust `#[command]` functions | Eliminates runtime errors from IPC boundary mismatches. Generates `.ts` bindings at build time. Required for multi-command apps. |

### AI / LLM Integration

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Vercel AI SDK (core) | 6.x | Multi-provider LLM calls (OpenAI, Anthropic), streaming, agent tool loops | Provider-agnostic. Works in Node.js without a server framework. Handles streaming, tool calling, multi-step agentic loops. Version 6 stable, `npm install ai`. |
| Node.js sidecar (pkg-compiled) | 22.x | Runtime for AI SDK — required because AI SDK needs Node.js, not WebView | Tauri's WebView cannot run Node.js. The official Tauri pattern is to compile a Node.js process as a sidecar binary and communicate via stdin/stdout JSON. Avoids having a separate server. |
| `@ai-sdk/openai` + `@ai-sdk/anthropic` | 1.x | Provider adapters for AI SDK | User provides their own API keys per project constraint. These adapters accept runtime-configured API keys. |

---

## Architecture Decision: AI Integration via Node.js Sidecar

The most architecturally significant decision is **how the AI SDK runs in a Tauri app**. The options are:

**Option A — Node.js sidecar (recommended):** Compile a Node.js process into a bundled binary using `pkg`. The Rust backend spawns it on startup. The frontend communicates via Tauri `invoke` → Rust → stdin/stdout to the sidecar. The AI SDK (which requires Node.js) runs cleanly inside the sidecar. Streaming is handled via newline-delimited JSON over stdout.

**Option B — Direct browser fetch to OpenAI/Anthropic:** Call provider APIs directly from the WebView using `fetch()`. Works for basic text generation but: loses AI SDK's agent/tool loop, streaming must be implemented manually, no provider abstraction. Viable for v1 if agent complexity is low but limits future capabilities.

**Recommendation:** Start with Option A (sidecar). The overhead is modest (JSON over stdout has negligible latency vs. LLM network calls), and it gives full AI SDK agent capabilities including multi-step tool loops, which are needed for slash-command agent skills.

---

## iCloud Sync Approach

No dedicated Tauri iCloud plugin exists or is needed. The correct approach:

1. Store the SQLite database file at `~/Library/Mobile Documents/com~apple~CloudDocs/ai-chat/data.db`
2. Use `tauri-plugin-fs` to write to this path
3. iCloud Drive syncs the file automatically — it's just a directory on disk
4. Use SQLite WAL mode to avoid corruption during sync hand-off

**Caveat (MEDIUM confidence):** SQLite + iCloud sync has known risks — if the file is modified on two devices simultaneously before sync completes, the last-write wins. For v1 single-user personal tool this is acceptable. For multi-device, add a conflict detection layer in a later milestone.

---

## Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| Rust stable toolchain | Tauri backend compilation | `rustup default stable`, required before `npm create tauri-app` |
| `@tauri-apps/cli` | Build, dev server, code signing | `npm install -D @tauri-apps/cli` |
| tauri-specta (build script) | TypeScript bindings generation | Run as part of Rust build script to regenerate `bindings.ts` on every Rust change |
| Drizzle Kit | Schema migration generation | `npx drizzle-kit generate` produces SQL that gets inlined at build time |
| `pkg` | Compiles Node.js sidecar to binary | Required to bundle sidecar for distribution without requiring user Node.js install |
| ESLint + Prettier | Code quality | Standard in all community templates |

---

## Installation

```bash
# Scaffold Tauri + React + TypeScript
npm create tauri-app@latest ai-chat -- --template react-ts
cd ai-chat

# UI layer
npm install tailwindcss@^4 @tailwindcss/vite
npm install react-arborist@^3.4.3
npm install @tiptap/react @tiptap/starter-kit @tiptap/extension-placeholder @tiptap/suggestion

# shadcn/ui
npx shadcn@latest init

# State management
npm install zustand@^5 @tanstack/react-query@^5

# Data layer
npm install @tauri-apps/plugin-sql
npm install drizzle-orm@^0.39
npm install -D drizzle-kit

# AI SDK
npm install ai @ai-sdk/openai @ai-sdk/anthropic

# Type safety for Rust commands
# tauri-specta is configured in Cargo.toml, not npm
```

```toml
# Cargo.toml additions
[dependencies]
tauri-specta = { version = "2.0.0-rc.21", features = ["derive", "typescript"] }
specta-typescript = "0.0.7"
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| react-arborist | MUI X TreeView | If you're already committed to MUI and need enterprise-grade accessibility; overkill here |
| react-arborist | react-vtree | If you need a pure virtualization primitive and want to build all interaction yourself |
| TipTap | CodeMirror | If notes are primarily code/markdown; TipTap is better for prose with slash commands |
| Zustand | Jotai | Either works — Jotai is atom-based which can be more granular for large trees, but Zustand has better community templates for Tauri |
| Drizzle proxy | tauri-plugin-sql (raw) | If you have very few queries and don't need type safety or schema management |
| Node.js sidecar | Direct WebView fetch | If agent features are minimal (just one-shot text generation, no tool loops); simplest to start but limited ceiling |
| SQLite + iCloud | JSON flat file | For extremely simple data (single-user, small trees), a JSON file in iCloud Drive syncs just as well without a DB layer — worth considering for an early prototype |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Electron | 10-20x larger binary (~150MB vs ~10MB), slower startup, no Rust backend reuse | Tauri (project constraint) |
| Redux / Redux Toolkit | Excessive boilerplate for a single-window desktop app with moderate state | Zustand |
| Next.js as Tauri frontend | Adds SSR complexity that's meaningless in a desktop app — pages are served from localhost bundle | Vite + React SPA |
| react-beautiful-dnd | Unmaintained (archived). Was the standard, now abandoned | @dnd-kit (or react-arborist's built-in DnD which wraps dnd-kit) |
| react-virtualized | Unmaintained, superseded by react-window and react-arborist | react-arborist (includes virtualization) |
| Prisma | Doesn't work in WebView context — requires Node.js runtime with direct FS access | Drizzle ORM in proxy mode |
| LangChain.js | Heavy abstraction layer, adds complexity without benefit for this use case; AI SDK 6 covers agentic loops natively | Vercel AI SDK |

---

## Stack Patterns by Variant

**If slash-command agent complexity grows beyond simple tool calls:**
- Add an MCP server in the Node.js sidecar
- Use `experimental_createMCPClient()` from AI SDK to connect to it
- Because MCP is the emerging standard for agent tool discovery (AI SDK 6 has full MCP support)

**If multi-device sync becomes critical before v2:**
- Replace SQLite + iCloud with libsql embedded replica + Turso cloud
- Use `tauri-plugin-libsql` which adds AES-256 encryption and embedded replica sync
- Because libsql is a drop-in SQLite replacement with bidirectional cloud sync

**If the tree needs to handle 100,000+ nodes:**
- Add lazy loading in react-arborist (load children on expand via TanStack Query)
- Partition the SQLite DB by year or workspace
- Because react-arborist only renders visible nodes but still loads all node metadata into memory

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| tauri@2.10.x | tauri-specta@2.0.0-rc.21 | tauri-specta v2 requires Tauri v2; not compatible with Tauri v1 |
| tauri@2.10.x | tauri-plugin-sql@2.x | v2 plugin API required |
| react-arborist@3.4.3 | React 18/19 | Works with both; last npm publish ~1 year ago |
| drizzle-orm@0.39+ | tauri-plugin-sql@2.x | Requires proxy driver pattern; not standard Drizzle setup |
| ai@6.x | Node.js ≥18 | Runs in sidecar, not WebView; WebView lacks Node.js globals |
| tailwindcss@4.x | shadcn/ui latest | shadcn/ui migrated to tw-animate-css (dropped tailwindcss-animate) |

---

## Sources

- Tauri releases: https://github.com/tauri-apps/tauri/releases — version 2.10.3 verified (HIGH confidence)
- Tauri Node.js sidecar official guide: https://v2.tauri.app/learn/sidecar-nodejs/ — sidecar pattern confirmed (HIGH confidence)
- AI SDK intro docs: https://ai-sdk.dev/docs/introduction — version 6.x current, Node.js support confirmed (HIGH confidence)
- AI SDK Tauri issue: https://github.com/vercel/ai/issues/7499 — MCP + Tauri pattern, sidecar architecture (MEDIUM confidence)
- tauri-specta GitHub: https://github.com/specta-rs/tauri-specta — version 2.0.0-rc.21 (HIGH confidence)
- Drizzle + Tauri pattern: https://dev.to/huakun/drizzle-sqlite-in-tauri-app-kif — proxy driver verified (MEDIUM confidence)
- react-arborist: https://github.com/brimdata/react-arborist — version 3.4.3, feature set verified (HIGH confidence)
- TipTap slash commands: https://tiptap.dev/docs/examples/experiments/slash-commands — official support confirmed (HIGH confidence)
- shadcn/ui + Tailwind v4: https://ui.shadcn.com/docs/tailwind-v4 — migration to tw-animate-css confirmed (HIGH confidence)
- iCloud Drive path: Apple developer docs `~/Library/Mobile Documents/com~apple~CloudDocs` — standard macOS path (HIGH confidence)
- Production Tauri template: https://github.com/dannysmith/tauri-template — three-layer state model (Zustand + TanStack Query) confirmed as community standard (MEDIUM confidence)

---

*Stack research for: Tauri desktop app — tree-based note-taking with AI agent*
*Researched: 2026-03-24*
