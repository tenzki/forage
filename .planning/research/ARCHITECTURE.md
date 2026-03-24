# Architecture Research

**Domain:** Tree-based outliner with embedded AI agent — Tauri desktop app
**Researched:** 2026-03-24
**Confidence:** MEDIUM-HIGH

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend Layer (WebView)                  │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Tree View   │  │ Slash Cmd UI │  │  Settings / Skills   │   │
│  │  (React +    │  │  (Autocmplt  │  │  Config Panel        │   │
│  │   Zustand)   │  │   overlay)   │  │                      │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                 │                      │               │
│  ┌──────┴─────────────────┴──────────────────────┴───────────┐   │
│  │              Frontend State (Zustand stores)               │   │
│  │  treeStore | editorStore | agentStore | settingsStore      │   │
│  └──────────────────────────┬────────────────────────────────┘   │
│                             │  invoke() / listen()               │
├─────────────────────────────┼───────────────────────────────────┤
│                    IPC Boundary (Tauri)                          │
├─────────────────────────────┼───────────────────────────────────┤
│                             │                                    │
│  ┌──────────────────────────┴────────────────────────────────┐   │
│                        Rust Backend Layer                        │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Tree CRUD   │  │ Agent Runner │  │   Sync Manager       │   │
│  │  Commands    │  │  (LLM calls, │  │  (iCloud file watch) │   │
│  │              │  │   streaming) │  │                      │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                 │                      │               │
│  ┌──────┴─────────────────┴──────────────────────┴───────────┐   │
│  │                    Storage Layer                           │   │
│  │  SQLite (sqlx)   |   Settings (JSON)  |  Skills (TOML)    │   │
│  └────────────────────────────────────────────────────────────┘  │
│                             │                                    │
│  ┌──────────────────────────┴────────────────────────────────┐   │
│  │              iCloud Drive Sync Layer                       │   │
│  │   File stored in ~/Library/Mobile Documents / iCloud/     │   │
│  │   NSFileCoordinator for safe concurrent access            │   │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| Tree View | Render infinite nested bullet list, handle keyboard nav, zoom-to-node | React + virtual scrolling (if deep trees) |
| Slash Command UI | Detect `/` trigger, show autocomplete overlay, dispatch command | Floating UI / Radix Popover over contenteditable |
| Zustand Stores | Frontend UI state: expanded nodes, cursor position, active agent runs | Zustand with immer middleware |
| Tree CRUD Commands | Tauri commands: create/read/update/delete/move nodes | Rust + sqlx async commands |
| Agent Runner | Parse slash command, build context from branch, call LLM API, stream results back | Rust + reqwest streaming, emit events to frontend |
| Sync Manager | Watch iCloud Drive folder, coordinate SQLite file access | Rust + notify crate + NSFileCoordinator (macOS) |
| SQLite (sqlx) | Durable store for all node data | Single .db file placed in iCloud Drive folder |
| Skills Config | Define available LLM skills (system prompt, model, tools) | TOML files in app config dir, loadable at runtime |
| Settings Store | API keys, active model, preferences | Encrypted JSON via tauri-plugin-store |

## Recommended Project Structure

```
ai-chat/
├── src/                          # Frontend (React + TypeScript)
│   ├── components/
│   │   ├── tree/
│   │   │   ├── TreeView.tsx       # Root outliner component
│   │   │   ├── TreeNode.tsx       # Single bullet node
│   │   │   ├── NodeEditor.tsx     # Contenteditable node editor
│   │   │   └── BreadcrumbBar.tsx  # Zoom path display
│   │   ├── agent/
│   │   │   ├── SlashMenu.tsx      # Slash command picker overlay
│   │   │   └── AgentStatus.tsx    # Streaming progress indicator
│   │   └── settings/
│   │       ├── SkillsConfig.tsx   # Manage skills
│   │       └── ApiKeys.tsx        # Key entry (never logged)
│   ├── stores/
│   │   ├── treeStore.ts           # Node tree state, selection, zoom root
│   │   ├── editorStore.ts         # Cursor, edit mode, expand state
│   │   ├── agentStore.ts          # Active runs, streaming buffer
│   │   └── settingsStore.ts       # Local settings cache
│   ├── hooks/
│   │   ├── useTreeCommands.ts     # Tauri invoke wrappers
│   │   ├── useSlashDetect.ts      # Input event -> slash command trigger
│   │   └── useAgentStream.ts      # Listen to agent stream events
│   ├── lib/
│   │   ├── tauri.ts               # Typed invoke wrappers
│   │   └── tree.ts                # Client-side tree traversal helpers
│   └── App.tsx
│
└── src-tauri/                     # Rust backend
    ├── src/
    │   ├── main.rs
    │   ├── commands/
    │   │   ├── tree.rs            # CRUD: node_create, node_update, node_delete, node_move
    │   │   ├── agent.rs           # run_skill, cancel_run, list_skills
    │   │   └── settings.rs        # get/set settings, validate API keys
    │   ├── db/
    │   │   ├── mod.rs
    │   │   ├── schema.rs          # SQLite schema (migrations via sqlx-migrate)
    │   │   └── queries.rs         # sqlx query functions
    │   ├── agent/
    │   │   ├── mod.rs
    │   │   ├── runner.rs          # Skill invocation, LLM API calls, result writing
    │   │   ├── skills.rs          # Load/parse TOML skill definitions
    │   │   └── context.rs         # Build branch context from tree for LLM prompt
    │   ├── sync/
    │   │   ├── mod.rs
    │   │   └── icloud.rs          # File coordination, change detection
    │   └── state.rs               # AppState struct (db pool, config)
    ├── Cargo.toml
    └── tauri.conf.json
```

### Structure Rationale

- **commands/**: All Tauri IPC entry points grouped by domain — makes the API surface discoverable and auditable
- **db/**: Isolated data access layer — commands never write SQL directly, only call db functions
- **agent/**: Self-contained module for all LLM concerns — runner, skill loading, context building; replaceable without touching tree logic
- **sync/**: Isolated sync concern — iCloud coordination wrapped here so future sync backends (CloudKit, Turso) can replace it
- **stores/ (frontend)**: Separate stores per concern — avoids a monolithic global store that becomes hard to reason about

## Architectural Patterns

### Pattern 1: Command + Event for Streaming Agent Output

**What:** Agent runs are started via a Tauri command (invoke) and progress is delivered via Tauri events (emit). The frontend subscribes to a run-specific event channel and appends streamed tokens as child nodes or inline text.

**When to use:** Any long-running backend operation that needs to update the UI incrementally. LLM streaming is the canonical case.

**Trade-offs:** Events are fire-and-forget — the frontend must handle missed events gracefully (reconnect, re-query). But it avoids blocking the command thread and gives fluid UI feedback.

**Example:**
```rust
// In agent.rs command
#[tauri::command]
pub async fn run_skill(
    app: AppHandle,
    node_id: String,
    skill_name: String,
    input: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let run_id_clone = run_id.clone();

    tauri::async_runtime::spawn(async move {
        // stream tokens from LLM, write child nodes to DB, emit events
        app.emit(&format!("agent:{}:token", run_id_clone), token).ok();
        app.emit(&format!("agent:{}:done", run_id_clone), node_ids).ok();
    });

    Ok(run_id) // returns immediately, frontend subscribes by run_id
}
```

```typescript
// In useAgentStream.ts
const runId = await invoke<string>('run_skill', { nodeId, skillName, input });
const unlisten = await listen<string>(`agent:${runId}:token`, (event) => {
  agentStore.appendToken(event.payload);
});
```

### Pattern 2: Adjacency List + Position for Tree Storage

**What:** Each node stores `parent_id` (nullable for root) and a `position` float (fractional indexing) for sibling ordering. No nested sets or closure tables needed for an outliner at personal scale.

**When to use:** Trees up to ~100k nodes, frequent insertions and moves, infrequent full-subtree reads. This is the Workflowy-style model.

**Trade-offs:** Recursive CTEs needed for subtree reads (SQLite supports `WITH RECURSIVE` since 3.8.3). Position floats eventually need renormalization but this is rare in practice. Simpler than closure tables for frequent writes.

**Example:**
```sql
CREATE TABLE nodes (
    id          TEXT PRIMARY KEY,          -- UUID
    parent_id   TEXT REFERENCES nodes(id) ON DELETE CASCADE,
    content     TEXT NOT NULL DEFAULT '',
    position    REAL NOT NULL DEFAULT 0,   -- fractional index for ordering
    collapsed   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,          -- Unix timestamp
    updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_nodes_parent ON nodes(parent_id, position);
```

```sql
-- Get full subtree (for building branch context for LLM)
WITH RECURSIVE subtree(id, content, depth) AS (
    SELECT id, content, 0 FROM nodes WHERE id = ?
    UNION ALL
    SELECT n.id, n.content, s.depth + 1
    FROM nodes n JOIN subtree s ON n.parent_id = s.id
    ORDER BY n.position
)
SELECT * FROM subtree;
```

### Pattern 3: Skills as TOML Config Files

**What:** Each LLM skill is defined as a TOML file with metadata, system prompt, and optional tool definitions. Skills are loaded at startup and reloaded on file change. The user can add custom skills by placing files in `~/Library/Application Support/ai-chat/skills/`.

**When to use:** When skills need to be user-configurable without recompiling. Enables a "skills marketplace" in the future.

**Trade-offs:** Requires validation on load. File watching adds complexity. But gives full extensibility without a UI for every configuration knob.

**Example:**
```toml
# skills/research.toml
[skill]
name = "research"
description = "Investigate a topic and structure findings as child notes"
trigger = "research"            # matches /research ...
model = "claude-3-5-sonnet"
temperature = 0.3

[skill.system_prompt]
text = """
You are a research assistant. Given a topic, you will produce a structured
set of findings as a bullet-point outline. Each top-level finding becomes
a child node. Use the provided branch context to stay relevant.
"""

[skill.output]
mode = "child_nodes"           # "child_nodes" | "inline" | "sibling_after"
max_nodes = 20
```

## Data Flow

### User Edits a Node

```
User types in NodeEditor
    ↓
useSlashDetect hook watches for "/" prefix
    ↓ (no slash)
debounced invoke("node_update", { id, content })
    ↓
Rust: db::queries::update_node(id, content)
    ↓
SQLite write
    ↓
Return Ok(()) → no UI update needed (optimistic update already applied in Zustand)
```

### Slash Command — Agent Run

```
User types "/research concurrent companies for LambdaWorks" + Enter
    ↓
SlashMenu parses command name ("research") and input text
    ↓
invoke("run_skill", { nodeId, skillName: "research", input })
    → returns runId immediately
    ↓
Frontend: listen(`agent:${runId}:token`) → appends to streaming buffer in agentStore
    ↓
Rust (async task):
    1. Load skill definition from skills.rs
    2. context.rs: recursive SQL query to build branch context (parent path + siblings)
    3. Build LLM prompt: system prompt + branch context + user input
    4. HTTP streaming request to LLM API (reqwest + tokio)
    5. For each token: emit `agent:{runId}:token` event
    6. On completion: write result nodes to SQLite, emit `agent:{runId}:done` with node IDs
    ↓
Frontend `done` handler: refresh subtree from Zustand (or trigger re-fetch)
```

### iCloud Sync Flow

```
User closes app on Machine A
    ↓
SQLite file in iCloud Drive folder
    ↓
macOS iCloud daemon detects change → uploads delta to iCloud
    ↓
Machine B comes online
    ↓
iCloud daemon downloads file
    ↓
Sync Manager (notify watcher) detects file change
    ↓
NSFileCoordinator acquires read lock
    ↓
New db connection opened / existing pool invalidated and re-opened
    ↓
Frontend receives `sync:updated` event → re-fetches active subtree
```

### State Management

```
Zustand treeStore
    ↓ (subscribe)
TreeView, TreeNode, BreadcrumbBar
    ↑ (actions)
useTreeCommands (invoke wrappers)
    ↑ (user interaction)
NodeEditor keyboard handlers
```

### Key Data Flows

1. **Node write path:** Frontend optimistic update → IPC invoke → Rust SQLite write → SQLite file in iCloud folder → OS syncs to cloud
2. **Agent result path:** Slash command → Rust async LLM stream → token events to frontend buffer → on-done: nodes written to DB → frontend re-renders subtree
3. **Sync receipt path:** iCloud file update → Rust file watcher → event to frontend → frontend re-fetches changed subtree from DB

## Scaling Considerations

This is a personal desktop app. Scale is measured in node count, not users.

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0–10k nodes | Adjacency list with `WITH RECURSIVE`, load full tree into Zustand on startup |
| 10k–100k nodes | Lazy-load: only fetch expanded subtrees, not full tree; add FTS5 virtual table for search |
| 100k+ nodes | WAL mode + connection pool, virtual scrolling required, consider pagination of search results |

### Scaling Priorities

1. **First bottleneck:** Full tree load into Zustand — fix by lazy-loading collapsed branches (fetch children only when expanded)
2. **Second bottleneck:** Full-text search over large trees — fix by enabling SQLite FTS5 virtual table on `nodes.content`

## Anti-Patterns

### Anti-Pattern 1: SQLite File in Non-iCloud Location

**What people do:** Store the SQLite file in the app's default data directory (`AppData / Application Support`) outside iCloud Drive.

**Why it's wrong:** iCloud sync is the entire v1 sync story. If the DB is not in the iCloud Drive folder (or `~/Library/Mobile Documents/`), there is nothing to sync.

**Do this instead:** On first launch, create or locate the DB file at `~/Library/Mobile Documents/iCloud~com~yourapp~ai-chat/Documents/data.db`. Use `NSFileCoordinator` on the Rust side via the `objc` crate or a Swift sidecar to prevent write conflicts during iCloud sync.

### Anti-Pattern 2: Storing Agent State in Frontend Only

**What people do:** Keep in-progress and completed agent run results only in Zustand/memory, writing to DB only after the entire run completes.

**Why it's wrong:** If the app crashes mid-run, all generated content is lost. Streaming tokens are also unrecoverable on app relaunch.

**Do this instead:** Write each batch of generated nodes to SQLite as they are produced during the stream. Emit events referencing persisted node IDs, not raw text. Frontend reads from DB for display after brief runs, streams from event buffer for UX responsiveness.

### Anti-Pattern 3: Putting Business Logic in Tauri Commands

**What people do:** Write complex tree manipulation, context building, and skill dispatch logic directly inside `#[tauri::command]` functions.

**Why it's wrong:** Commands become impossible to unit test without a full Tauri runtime. Rust unit tests can't easily mock the IPC layer.

**Do this instead:** Keep commands thin — they deserialize inputs, call into service modules (`db::`, `agent::`, `sync::`), and serialize outputs. All logic lives in testable pure functions in those modules.

### Anti-Pattern 4: Writing SQLite from the Frontend

**What people do:** Use the `@tauri-apps/plugin-sql` package to write directly from TypeScript to SQLite.

**Why it's wrong:** Bypasses the Rust backend where file coordination, schema migrations, and agent write coordination live. Creates two write paths that can race. The plugin also has no encryption support and limited Drizzle integration.

**Do this instead:** All reads and writes go through `invoke()` to typed Rust commands. The frontend never holds a DB connection.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| OpenAI API | Rust `reqwest` streaming POST to `/v1/chat/completions` with `stream: true` | API key stored in encrypted settings, never passed to frontend |
| Anthropic API | Same pattern, different endpoint and headers (`anthropic-version` header) | Support both providers; skill config specifies which to use |
| iCloud Drive | File placed in iCloud-managed folder; OS handles upload/download | No CloudKit API calls needed; NSFileCoordinator for safe access |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Frontend ↔ Rust backend | Tauri IPC: `invoke()` for commands, `listen()` for events | All data JSON-serialized; keep payloads minimal |
| Agent Runner ↔ Tree DB | Direct Rust function calls within backend | Agent writes nodes to DB same as user edits; same query layer |
| Sync Manager ↔ DB Pool | Sync manager signals pool to re-open after iCloud file swap | SQLite WAL mode reduces corruption risk; pool invalidation on file change |
| Skills Config ↔ Agent Runner | In-process load: `skills::load_all()` returns `Vec<Skill>` | Skills reloaded on file change via notify watcher; hot reload without restart |

## Build Order Implications

The component dependency graph dictates this build sequence:

1. **DB schema + CRUD commands** — everything else depends on node storage
2. **Tree View + Zustand treeStore** — can be built with in-memory mock data before DB is wired
3. **IPC wiring** — connect Tree View to real DB commands
4. **Keyboard navigation + expand/collapse** — requires working tree render
5. **Search** — requires DB with FTS5 enabled
6. **Slash command parser + overlay UI** — standalone, only needs node context from treeStore
7. **Skills system (TOML loader + context builder)** — needs working tree to test context extraction
8. **Agent Runner + LLM integration** — needs skills system and DB write path
9. **Streaming UI (agentStore + token events)** — needs Agent Runner emitting events
10. **iCloud sync** — needs stable DB file location; add last to avoid sync interfering with development

## Sources

- [Tauri IPC — Inter-Process Communication](https://v2.tauri.app/concept/inter-process-communication/)
- [Tauri Calling Rust from Frontend](https://v2.tauri.app/develop/calling-rust/)
- [Tauri State Management](https://v2.tauri.app/develop/state-management/)
- [rust-genai: Rust multi-provider LLM client](https://github.com/jeremychone/rust-genai)
- [Building a Local-First Tauri App with Drizzle ORM, Encryption, and Turso Sync](https://dev.to/huakun/building-a-local-first-tauri-app-with-drizzle-orm-encryption-and-turso-sync-31pn)
- [SQLite WAL mode documentation](https://www.sqlite.org/wal.html)
- [Hierarchical data in SQL — adjacency list, closure table, nested sets](https://teddysmith.io/sql-trees/)
- [iOS iCloud Drive Synchronization Deep Dive](https://zottmann.org/2025/09/08/ios-icloud-drive-synchronization-deep.html)
- [Agent Skills Architecture Overview](https://shuji-bonji.github.io/ai-agent-architecture/skills/what-is-skills)
- [LLM Agents — Prompt Engineering Guide](https://www.promptingguide.ai/research/llm-agents)
- [tauri-global-state-management pattern](https://github.com/robosushie/tauri-global-state-management)

---
*Architecture research for: Tree-based outliner with embedded AI agent — Tauri desktop app*
*Researched: 2026-03-24*
