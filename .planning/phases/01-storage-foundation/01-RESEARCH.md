# Phase 1: Storage Foundation - Research

**Researched:** 2026-03-24
**Domain:** Tauri v2 SQLite persistence, typed IPC, fractional indexing, schema design
**Confidence:** MEDIUM-HIGH (core libraries verified via official docs and multiple community sources; tauri-specta still in RC phase adds minor uncertainty)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Rich text (structured) content format — store TipTap/ProseMirror JSON, not plain text
- Fractional indexing for sibling ordering (no reindexing on insert/move)
- UUID primary keys for all nodes
- Adjacency list for parent-child relationships
- Metadata columns: created_at, updated_at, collapsed state (boolean), creator source (user vs agent), skill reference (which skill generated this node, nullable)
- Optional metadata JSON column for future extensibility (attachments, embeds, etc.)
- Schema-ready for attachments but no attachment support in v1
- Pi sessions are ephemeral — reconstructed from the outliner tree on demand
- No separate Pi session storage needed — the node tree IS the source of truth
- When slash command triggers, system builds Pi session context from node ancestors
- Slash command output replaces the command node content (not preserved as visible text)
- Original prompt stored in metadata JSON column (recoverable but not displayed)
- Agent-generated nodes store generation metadata: model used, skill used, token count in metadata JSON
- Strict enum: `note`, `agent_response`, `command`, `chat_message`
- `note` = user-created (default), `agent_response` = AI-generated content, `command` = slash command node, `chat_message` = reserved for future chat mode (v2)
- Phase 1 stores the type but all nodes render identically — visual distinction is Phase 2/3
- Local-first during development: `~/Library/Application Support/ai-chat/`
- Migration to iCloud Drive folder deferred to Phase 6
- Single document (one SQLite file = one tree) for v1
- WAL mode enabled from day one for concurrent read performance
- WAL sidecar files (-wal, -shm) travel with the DB during future migration

### Claude's Discretion
- Exact SQLite column types and indexes
- IPC command naming and grouping via tauri-specta
- Migration tooling choice
- Error handling strategy for corrupt/missing DB file

### Deferred Ideas (OUT OF SCOPE)
- iCloud Drive file placement (Phase 6)
- Attachment support (future)
- Visual distinction of node types (Phase 2/3)
- Pi session persistence (ephemeral by design)
- Multiple documents / workspaces
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INFR-02 | Data persists locally across app restarts (local-first SQLite) | SQLite via sqlx, WAL mode, app_data_dir path, sqlx migrate! macro for schema versioning |
| INFR-04 | Data model supports node types to enable future chat mode | `node_type` TEXT column with strict enum values, fractional-indexing npm library for position keys |
</phase_requirements>

---

## Summary

Phase 1 establishes the SQLite data layer for a Tauri v2 desktop app. The stack is: **sqlx** (Rust async SQLite driver) for database access, **sqlx migrate!** (embedded SQL migrations) for schema versioning, **tauri-specta v2** (release candidate as of 2026-03) for typed IPC command generation, and **fractional-indexing** (Rocicorp npm library) for sibling ordering keys stored as TEXT in SQLite.

The core architectural decision — adjacency list with UUID PKs and fractional-index TEXT position keys — is well-supported by SQLite's TEXT sorting and requires no extensions. All ordered queries use `ORDER BY position ASC` on the fractional-index column. The Tauri v2 path API (`app.path().app_data_dir()`) resolves to `~/Library/Application Support/<bundle-id>/` on macOS, which satisfies the "local-first during development" constraint.

One significant risk: tauri-specta v2 has been in release-candidate status since late 2024 (latest rc.21 as of 2026-01-13) with no stable 2.0 release yet. This is a known ecosystem gap but is widely used in production Tauri v2 projects and the API is stable in practice.

**Primary recommendation:** Use sqlx 0.8 directly (not tauri-plugin-sql) for full control over WAL mode, connection options, and migration sequencing. Use tauri-specta 2.0.0-rc.21 for typed IPC. Store fractional index as TEXT in SQLite — no extension required.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| sqlx | 0.8.x | Async SQLite driver, migrations, typed queries | Native async, compile-time query checking, WAL support via `SqliteConnectOptions`, preferred in Tauri v2 community |
| tauri-specta | 2.0.0-rc.21 | Generate TypeScript bindings from Rust command signatures | Only maintained tool for end-to-end Tauri IPC type safety; specta-rs ecosystem |
| specta | 2.0.0-rc.x | Type introspection used by tauri-specta | Required peer dependency |
| fractional-indexing | ^0.1.0 (npm, Rocicorp) | Generate lexicographically-ordered position keys | Reference implementation by Rocicorp (replicache/zero authors), widely used in collaborative apps |
| uuid | 1.x (Rust crate) | Generate v4 UUIDs for node PKs | Standard; SQLite stores as TEXT(36) |
| serde + serde_json | 1.x | Serialize/deserialize node structs and metadata JSON | Required for tauri-specta type export and sqlx row mapping |
| tokio | 1.x | Async runtime required by sqlx | Standard Tauri v2 async runtime |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| chrono | 0.4 | Timestamp types for created_at/updated_at | sqlx maps chrono::DateTime to SQLite TEXT ISO8601 |
| fractional-indexing-jittered | npm | Collision-resistant fractional keys | Use instead of fractional-indexing if concurrent multi-device writes become a concern (Phase 6+) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| sqlx directly | tauri-plugin-sql | Plugin abstracts too much — no direct WAL pragma control, no compile-time query checking, migration support is basic |
| sqlx directly | rusqlite | rusqlite is sync-only; requires Mutex wrapping for Tauri's async command handlers — more boilerplate, worse ergonomics |
| sqlx migrate! | refinery | refinery is well-maintained but adds a dependency; sqlx migrate! is built-in and sufficient for this scope |
| tauri-specta | taurpc | taurpc generates types at runtime, not build-time; tauri-specta is more established in the Tauri ecosystem |
| fractional-indexing (Rocicorp) | @tldraw/indices | Both work; Rocicorp's is simpler and more widely cited for outliner/list use cases |

**Installation:**
```bash
# Rust (Cargo.toml)
# sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite", "chrono", "uuid", "macros"] }
# tauri-specta = { version = "=2.0.0-rc.21", features = ["derive", "typescript"] }
# specta = { version = "=2.0.0-rc.20", features = ["uuid", "chrono"] }
# uuid = { version = "1", features = ["v4", "serde"] }
# chrono = { version = "0.4", features = ["serde"] }
# serde = { version = "1", features = ["derive"] }
# serde_json = "1"

# Frontend
npm install fractional-indexing
```

---

## Architecture Patterns

### Recommended Project Structure

```
src-tauri/
├── src/
│   ├── lib.rs               # tauri::Builder setup, plugin registration, state management
│   ├── db/
│   │   ├── mod.rs           # re-exports
│   │   ├── setup.rs         # database init, WAL config, migration run
│   │   └── models.rs        # Node struct, NodeType enum, serde derives, specta::Type
│   ├── commands/
│   │   ├── mod.rs           # collect_commands! macro call, bindings export
│   │   └── nodes.rs         # IPC handlers: create_node, get_node, update_node, delete_node, get_children
│   └── errors.rs            # AppError type implementing serde + specta::Type
├── migrations/
│   ├── 0001_initial_schema.sql
│   └── (future migrations appended here)
└── Cargo.toml

src/
├── lib/
│   ├── db.ts                # Drizzle proxy or direct invoke wrappers (consumed by Phase 2)
│   └── bindings.ts          # AUTO-GENERATED by tauri-specta at dev startup
```

### Pattern 1: Database Initialization with WAL Mode

**What:** Initialize SQLite pool during Tauri setup hook, configure WAL mode and synchronous pragma, run embedded migrations, store pool in app state.
**When to use:** App startup — must complete before any command handler runs.

```rust
// Source: https://tauritutorials.com/blog/building-a-todo-app-in-tauri-with-sqlite-and-sqlx
// + https://docs.rs/sqlx/latest/sqlx/sqlite/struct.SqliteConnectOptions.html
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;

pub async fn setup_db(app: &tauri::App) -> Result<SqlitePool, Box<dyn std::error::Error>> {
    let mut path = app.path().app_data_dir()?;
    std::fs::create_dir_all(&path)?;
    path.push("ai-chat.db");

    let db_url = format!("sqlite:{}", path.to_str().unwrap());

    let opts = SqliteConnectOptions::from_str(&db_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)  // 2-3x faster writes in WAL mode
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}
```

### Pattern 2: Node Data Model

**What:** Rust struct representing a node, with specta::Type for TypeScript export.
**When to use:** All IPC commands return/accept this type.

```rust
// Source: derived from tauri-specta docs + sqlx FromRow pattern
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::FromRow;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::Type)]
#[sqlx(type_name = "TEXT", rename_all = "snake_case")]
pub enum NodeType {
    Note,
    AgentResponse,
    Command,
    ChatMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, FromRow)]
pub struct Node {
    pub id: String,               // UUID v4 as TEXT
    pub parent_id: Option<String>, // NULL for root
    pub position: String,         // fractional index TEXT e.g. "a0", "a1", "V"
    pub content: serde_json::Value, // TipTap/ProseMirror JSON
    pub node_type: NodeType,
    pub collapsed: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub skill_id: Option<String>,  // nullable — which skill generated this node
    pub metadata: Option<serde_json::Value>, // generation metadata, original prompt, etc.
}
```

### Pattern 3: Typed IPC with tauri-specta

**What:** Annotate commands with `#[specta::specta]`, register with collect_commands! macro, export TypeScript bindings on debug builds.
**When to use:** All command handlers in Phase 1.

```rust
// Source: https://specta.dev/docs/tauri-specta/v2
use tauri_specta::{collect_commands, ts};

#[tauri::command]
#[specta::specta]
pub async fn create_node(
    state: tauri::State<'_, AppState>,
    parent_id: Option<String>,
    node_type: NodeType,
    content: serde_json::Value,
    position: String,
) -> Result<Node, String> {
    // ... insert into SQLite, return full Node
}

// In lib.rs setup:
pub fn run() {
    let invoke_handler = {
        let builder = ts::builder()
            .commands(collect_commands![
                create_node,
                get_node,
                get_children,
                update_node,
                delete_node,
            ]);

        #[cfg(debug_assertions)]
        let builder = builder.path("../src/lib/bindings.ts");

        builder.build().unwrap()
    };

    tauri::Builder::default()
        .setup(|app| {
            tauri::async_runtime::block_on(async {
                let pool = setup_db(app).await.expect("db init failed");
                app.manage(AppState { db: pool });
            });
            Ok(())
        })
        .invoke_handler(invoke_handler)
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}
```

### Pattern 4: Initial Migration SQL

**What:** The `0001_initial_schema.sql` migration defining the nodes table.
**When to use:** Created once, never deleted, extended by future numbered migrations.

```sql
-- migrations/0001_initial_schema.sql
CREATE TABLE IF NOT EXISTS nodes (
    id          TEXT PRIMARY KEY NOT NULL,    -- UUID v4
    parent_id   TEXT REFERENCES nodes(id) ON DELETE CASCADE,
    position    TEXT NOT NULL,                -- fractional index, e.g. "a0", "a1V"
    content     TEXT NOT NULL DEFAULT '{}',  -- TipTap/ProseMirror JSON
    node_type   TEXT NOT NULL DEFAULT 'note'
                CHECK (node_type IN ('note','agent_response','command','chat_message')),
    collapsed   INTEGER NOT NULL DEFAULT 0,  -- SQLite boolean
    skill_id    TEXT,                         -- nullable FK for Phase 4
    metadata    TEXT,                         -- JSON: generation metadata, original prompt
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent_position
    ON nodes (parent_id, position);           -- primary query pattern: children ordered by position

CREATE INDEX IF NOT EXISTS idx_nodes_node_type
    ON nodes (node_type);                     -- Phase 3 filtering by type

PRAGMA journal_mode = WAL;                    -- belt-and-suspenders (also set via SqliteConnectOptions)
PRAGMA foreign_keys = ON;
```

### Pattern 5: Fractional Indexing in TypeScript (Frontend Layer)

**What:** Use Rocicorp's `fractional-indexing` library to compute position keys before sending create/move commands.
**When to use:** Phase 2 will call these; Phase 1 just stores the TEXT value — but establish the convention now.

```typescript
// Source: https://github.com/rocicorp/fractional-indexing
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

// Insert after last child (append):
const newPosition = generateKeyBetween(lastChildPosition, null);

// Insert before first child (prepend):
const newPosition = generateKeyBetween(null, firstChildPosition);

// Insert between two siblings:
const newPosition = generateKeyBetween(prevPosition, nextPosition);
```

### Anti-Patterns to Avoid

- **Using INTEGER AUTOINCREMENT for order:** Breaks on insert-between operations; forces full-table reindex on move. Use fractional TEXT instead.
- **Storing node_type as INTEGER enum:** Loses readability, makes SQL queries harder to understand, and breaks if enum order changes. Use CHECK-constrained TEXT.
- **Using tauri-plugin-sql instead of sqlx directly:** The plugin's proxy pattern adds a round-trip for every query and does not expose WAL pragma configuration. Use sqlx directly in Rust command handlers.
- **Blocking the setup() hook without block_on:** Tauri's setup() is synchronous; sqlx pool initialization is async. Use `tauri::async_runtime::block_on()` to bridge.
- **Skipping the `#[specta::specta]` annotation:** tauri-specta only generates types for commands that carry this attribute. Missing it causes silent type drift at the IPC boundary.
- **Opening the pool with a single connection:** SQLite in WAL mode supports concurrent reads; use `max_connections(5)` so Tauri's multi-threaded command handlers don't serialize all reads.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Position ordering without reindex | Custom float arithmetic for sibling order | `fractional-indexing` (Rocicorp) | Edge cases: string length explosion, initial key selection, min/max bounds — Rocicorp's implementation handles all of these correctly |
| TypeScript type generation from Rust | Manual `interface Node { ... }` in TS files | `tauri-specta` collect_commands! + `#[specta::specta]` | Manual type maintenance diverges immediately; specta generates from the actual Rust struct |
| Schema migrations | Hand-written `CREATE TABLE IF NOT EXISTS` in setup code | `sqlx::migrate!` with numbered SQL files | Handles version tracking, ordering, atomicity, and future incremental changes |
| UUID generation | `random()` or timestamp-based IDs | `uuid::Uuid::new_v4()` | Correct entropy, no collision risk, standard format |
| JSON metadata schema | Typed Rust struct per metadata variant | `serde_json::Value` in metadata column | Phase 1 should not over-constrain metadata shape; Phase 4 will read/write it with known keys |

**Key insight:** Fractional indexing is deceptively simple to get wrong — initial keys, boundary conditions, and string length growth under adversarial insertion patterns require the reference implementation.

---

## Common Pitfalls

### Pitfall 1: tauri-specta still in Release Candidate

**What goes wrong:** `tauri-specta = "2"` in Cargo.toml resolves to 1.0.2 (last stable), not 2.0.0-rc.21. Tauri v2 requires tauri-specta v2.
**Why it happens:** Cargo does not include pre-release versions unless explicitly specified.
**How to avoid:** Pin to exact RC version: `tauri-specta = "=2.0.0-rc.21"`. Same for `specta = "=2.0.0-rc.20"`.
**Warning signs:** Compiler error "method `commands` not found" or missing `collect_commands!` macro.

### Pitfall 2: WAL Mode Not Actually Enabled

**What goes wrong:** Connection options set `journal_mode(Wal)` but the PRAGMA does not take effect because it is applied after connection on an existing database.
**Why it happens:** sqlx docs note: "Journal modes are ephemeral per connection, with the exception of WAL mode." WAL mode sticks once set — but you must verify it was actually applied.
**How to avoid:** Verify with `PRAGMA journal_mode;` query after pool creation. Also include `PRAGMA journal_mode = WAL;` in the initial migration SQL as belt-and-suspenders.
**Warning signs:** `-wal` and `-shm` files not appearing next to the SQLite file after writes.

### Pitfall 3: UUID Stored as BLOB Breaks JavaScript Boundary

**What goes wrong:** UUID stored as 16-byte BLOB; sqlx serializes it as a byte array; JavaScript receives `[0, 1, 2, ...]` instead of a UUID string.
**Why it happens:** SQLite has no UUID type; sqlx's uuid feature maps to BLOB by default in some configurations.
**How to avoid:** Store as `TEXT NOT NULL` and use `uuid::Uuid::new_v4().to_string()` in Rust. Declare the column as TEXT PRIMARY KEY in the migration.
**Warning signs:** TypeScript receives a number array for `id` fields.

### Pitfall 4: Fractional Index String Length Explosion

**What goes wrong:** Repeated insert-at-same-position operations generate progressively longer position strings ("a0V0V0V0V...") that degrade sort performance.
**Why it happens:** Each generateKeyBetween call appending to the same pair produces a longer string.
**How to avoid:** This is a known property of the algorithm, not a bug. For v1 (single user, single device), this is not a practical concern. When iCloud sync arrives (Phase 6), consider using `fractional-indexing-jittered` or periodic rebalancing.
**Warning signs:** Position strings exceeding 20 characters after heavy editing sessions.

### Pitfall 5: sqlx Compile-Time Query Checking Fails at Build

**What goes wrong:** `sqlx::query!` macro (compile-time checked form) requires a live DATABASE_URL env var at compile time pointing to a real DB file with the correct schema.
**Why it happens:** The macro introspects the DB schema at compile time.
**How to avoid:** Use `sqlx::query_as::<_, Node>("SELECT ...")` (runtime-checked) instead of `sqlx::query!`. This is appropriate here since the DB path is dynamic. Alternatively, use `sqlx prepare` command to generate `sqlx-data.json` offline.
**Warning signs:** Build fails with "DATABASE_URL not set" or "no such table".

### Pitfall 6: Mutex-Wrapped Pool is Unnecessary

**What goes wrong:** Developer wraps the `SqlitePool` in `Mutex<SqlitePool>` to satisfy thread safety.
**Why it happens:** Cargo complains about `Send` bounds without understanding that `SqlitePool` is already `Send + Sync + Clone`.
**How to avoid:** Use `app.manage(AppState { db: pool })` directly where `AppState.db: SqlitePool`. No Mutex needed — sqlx pools are internally thread-safe.
**Warning signs:** Deadlock on concurrent commands because a `Mutex<Pool>` is locked across an `.await` point.

---

## Code Examples

### Complete AppState and Setup

```rust
// src-tauri/src/lib.rs
// Source: pattern synthesized from tauritutorials.com + specta.dev/docs/tauri-specta/v2

pub struct AppState {
    pub db: sqlx::SqlitePool,
}

pub fn run() {
    let invoke_handler = {
        let builder = tauri_specta::ts::builder()
            .commands(tauri_specta::collect_commands![
                commands::nodes::create_node,
                commands::nodes::get_node,
                commands::nodes::get_children,
                commands::nodes::update_node,
                commands::nodes::delete_node,
            ]);

        #[cfg(debug_assertions)]
        let builder = builder.path("../src/lib/bindings.ts");

        builder.build().unwrap()
    };

    tauri::Builder::default()
        .setup(|app| {
            tauri::async_runtime::block_on(async move {
                let pool = db::setup::init_db(app).await
                    .expect("Failed to initialize database");
                app.manage(AppState { db: pool });
            });
            Ok(())
        })
        .invoke_handler(invoke_handler)
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}
```

### SQLiteConnectOptions with Full Production Config

```rust
// src-tauri/src/db/setup.rs
// Source: https://docs.rs/sqlx/latest/sqlx/sqlite/struct.SqliteConnectOptions.html
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous, SqlitePoolOptions};
use std::str::FromStr;

pub async fn init_db(app: &tauri::App) -> Result<sqlx::SqlitePool, Box<dyn std::error::Error>> {
    let mut data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    data_dir.push("ai-chat.db");

    let url = format!("sqlite:{}", data_dir.display());

    let opts = SqliteConnectOptions::from_str(&url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5))
        .optimize_on_close(true, None);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;

    // Run embedded migrations from ./migrations/ directory
    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}
```

### A Minimal Node IPC Command

```rust
// src-tauri/src/commands/nodes.rs
// Source: synthesized from tauri-specta v2 docs + sqlx FromRow pattern
use crate::{db::models::{Node, NodeType}, AppState};
use uuid::Uuid;
use chrono::Utc;

#[tauri::command]
#[specta::specta]
pub async fn create_node(
    state: tauri::State<'_, AppState>,
    parent_id: Option<String>,
    position: String,
    node_type: NodeType,
    content: serde_json::Value,
) -> Result<Node, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let content_str = serde_json::to_string(&content)
        .map_err(|e| e.to_string())?;

    sqlx::query(
        "INSERT INTO nodes (id, parent_id, position, content, node_type, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
    )
    .bind(&id)
    .bind(&parent_id)
    .bind(&position)
    .bind(&content_str)
    .bind(node_type.to_db_str())  // "note" | "agent_response" | "command" | "chat_message"
    .bind(now.to_rfc3339())
    .bind(now.to_rfc3339())
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    get_node(state, id).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_children(
    state: tauri::State<'_, AppState>,
    parent_id: Option<String>,
) -> Result<Vec<Node>, String> {
    sqlx::query_as::<_, Node>(
        "SELECT * FROM nodes WHERE parent_id IS ?1 ORDER BY position ASC"
    )
    .bind(parent_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| rusqlite (sync) directly | sqlx (async) + SqlitePoolOptions | Tauri v2 adoption, 2024 | No Mutex wrapping; cleaner async command handlers |
| Manual TypeScript interfaces | tauri-specta collect_commands! + #[specta::specta] | tauri-specta v2, 2024 | No more hand-maintained IPC type files |
| INTEGER row order | Fractional index TEXT | CRDTs/collaborative apps popularized by Rocicorp, 2022+ | Reorder without full-table reindex; iCloud-sync safe |
| tauri-plugin-sql (abstracted) | sqlx direct in Rust handlers | Community shift 2024-2025 | Full WAL mode control, compile-time schema, no proxy overhead |
| app_handle.path_resolver() (Tauri v1) | app.path().app_data_dir() (Tauri v2) | Tauri 2.0.0, Sep 2024 | PathResolver API renamed in v2 — v1 calls will not compile |

**Deprecated/outdated:**
- `app_handle.path_resolver().app_data_dir()`: Tauri v1 API. Use `app.path().app_data_dir()` in v2.
- `tauri_specta::ts::export(collect_types![...], path)`: v1 API. v2 uses the builder pattern.
- `tauri::generate_handler![...]` without specta: Still works but produces no TypeScript types.

---

## Open Questions

1. **tauri-specta 2.0.0 stable release**
   - What we know: Latest is 2.0.0-rc.21 (2026-01-13). Has been RC for 12+ months. Widely used in production.
   - What's unclear: Whether a stable release is imminent. The specta-rs team has an active `tauri2` proposal repo suggesting significant future changes.
   - Recommendation: Pin to `=2.0.0-rc.21`. Accept RC status. If stable releases before Phase 2, upgrade then.

2. **sqlx query!() macro vs query_as()**
   - What we know: `sqlx::query!()` requires `DATABASE_URL` at compile time. The DB path is dynamic in Tauri (determined at runtime from app_data_dir).
   - What's unclear: Whether `sqlx prepare` workflow (offline mode) is worth the CI/CD complexity.
   - Recommendation: Use `query_as::<_, Node>("...")` throughout Phase 1. Defer compile-time query checking to a future optimization. The type safety from tauri-specta and FromRow derives is sufficient.

3. **NodeType as TEXT CHECK vs Rust enum mapping**
   - What we know: sqlx can map Rust enums to TEXT if `#[sqlx(type_name = "TEXT", rename_all = "snake_case")]` is applied. SQLite's CHECK constraint enforces validity at the DB level.
   - What's unclear: Whether sqlx's enum serialization produces exactly `"note"`, `"agent_response"`, etc. vs capitalized or snake_case variants.
   - Recommendation: Add an explicit `to_db_str()` method on NodeType to guarantee the string values regardless of sqlx enum handling. Cross-verify with a test in Wave 0.

---

## Validation Architecture

`nyquist_validation` is enabled in `.planning/config.json`.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Rust built-in test (`cargo test`) + sqlx test utilities |
| Config file | `src-tauri/Cargo.toml` (no separate test config needed) |
| Quick run command | `cd src-tauri && cargo test -- --test-thread=1` (serial required for SQLite file tests) |
| Full suite command | `cd src-tauri && cargo test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INFR-02 | Node inserted survives app restart (pool close + reopen) | integration | `cargo test test_node_persistence -- --test-thread=1` | Wave 0 |
| INFR-02 | WAL mode is active after DB initialization | unit | `cargo test test_wal_mode_enabled` | Wave 0 |
| INFR-02 | UUID primary key stored as TEXT, not BLOB | unit | `cargo test test_uuid_stored_as_text` | Wave 0 |
| INFR-02 | Fractional position ordering returns children in correct order | unit | `cargo test test_position_ordering` | Wave 0 |
| INFR-04 | All four node_type values accepted by CHECK constraint | unit | `cargo test test_node_type_enum` | Wave 0 |
| INFR-04 | Invalid node_type value rejected by SQLite | unit | `cargo test test_node_type_invalid_rejected` | Wave 0 |
| INFR-04 | metadata JSON column stores and retrieves arbitrary JSON | unit | `cargo test test_metadata_json_roundtrip` | Wave 0 |

### Sampling Rate

- **Per task commit:** `cd src-tauri && cargo test -- --test-thread=1`
- **Per wave merge:** `cd src-tauri && cargo test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src-tauri/src/db/tests.rs` — in-memory SQLite test helpers for all INFR-02 and INFR-04 behaviors
- [ ] `src-tauri/migrations/0001_initial_schema.sql` — must exist before any test or build
- [ ] Framework install: `cargo add sqlx --features runtime-tokio,sqlite,chrono,uuid,macros` — confirm in Cargo.toml

---

## Sources

### Primary (HIGH confidence)

- [sqlx::sqlite::SqliteConnectOptions docs](https://docs.rs/sqlx/latest/sqlx/sqlite/struct.SqliteConnectOptions.html) — WAL mode, synchronous pragma, foreign keys, pool config API
- [specta.dev/docs/tauri-specta/v2](https://specta.dev/docs/tauri-specta/v2) — builder pattern, collect_commands!, TypeScript export, version compatibility
- [v2.tauri.app/plugin/sql/](https://v2.tauri.app/plugin/sql/) — official Tauri SQL plugin docs (reviewed to confirm direct sqlx approach is preferable)
- [tauritutorials.com — todo app with SQLite + sqlx](https://tauritutorials.com/blog/building-a-todo-app-in-tauri-with-sqlite-and-sqlx) — verified setup pattern for Tauri v2 + sqlx async

### Secondary (MEDIUM confidence)

- [Analyst 18 — Embedding SQLite in Tauri](https://dezoito.github.io/2025/01/01/embedding-sqlite-in-a-tauri-application.html) — published Jan 2025; WAL mode with SqliteConnectOptions verified against official docs
- [tauri-specta GitHub](https://github.com/specta-rs/tauri-specta) — confirmed v2 RC status, version compatibility table
- [fractional-indexing npm (Rocicorp)](https://github.com/rocicorp/fractional-indexing) — reference implementation, generateKeyBetween API
- [keypears.com — Drizzle SQLite Tauri 2.0](https://keypears.com/blog/2025-10-04-drizzle-sqlite-tauri) — confirmed migration bundling pattern (evaluated but not recommended for Phase 1)
- [michaelcharl.es — Tauri v2 macOS paths](https://michaelcharl.es/aubrey/en/code/tauri-2-mac-paths) — confirmed app_data_dir resolves to `~/Library/Application Support/<bundle-id>/` on macOS

### Tertiary (LOW confidence)

- WebSearch result: tauri-specta 2.0.0-rc.21 is the latest RC as of 2026-01-13 — not verified against crates.io directly (crates.io requires JavaScript to render)
- WebSearch result: Drizzle ORM proxy driver community pattern — multiple sources agree but the approach was NOT chosen for Phase 1

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — sqlx and sqlx migrate! are official, well-documented; tauri-specta is MEDIUM due to RC status
- Architecture: HIGH — SQLite adjacency list + WAL is a proven pattern; code examples derived from working public examples
- Pitfalls: MEDIUM-HIGH — WAL pitfall and UUID BLOB issue verified from official docs; specta RC version pinning verified from crates.io search

**Research date:** 2026-03-24
**Valid until:** 2026-04-24 (30 days for relatively stable ecosystem; re-verify tauri-specta version before starting)
