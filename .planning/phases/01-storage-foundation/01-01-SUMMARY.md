---
phase: 01-storage-foundation
plan: 01
subsystem: database
tags: [tauri, rust, sqlite, sqlx, tauri-specta, specta, uuid, fractional-indexing, serde]

requires: []

provides:
  - Tauri v2 project scaffolded with all SQLite/IPC dependencies
  - SQLite migration with nodes table (UUID PK, adjacency list, fractional position, node_type CHECK, metadata JSON)
  - Node struct and NodeType enum with serde + specta::Type derives
  - AppError typed error enum with From<sqlx::Error>
  - init_db function with WAL mode, Normal sync, foreign_keys enforcement
  - AppState wired into Tauri setup hook via block_on
  - fractional-indexing npm package installed

affects:
  - 01-02 (IPC commands layer builds on AppState and Node types)
  - 02-frontend (consumes Node type via tauri-specta bindings.ts)
  - 03-search (extends nodes table with FTS5 migration)
  - 04-agent (reads metadata JSON column, uses skill_id column)

tech-stack:
  added:
    - sqlx 0.8 (runtime-tokio, sqlite, chrono, uuid, macros features)
    - tauri-specta 2.0.0-rc.21 (derive, typescript features)
    - specta 2.0.0-rc.22 (uuid, chrono, serde_json features)
    - specta-typescript 0.0.9
    - uuid 1.x (v4, serde features)
    - chrono 0.4 (serde feature)
    - serde + serde_json 1.x
    - tokio 1.x (full feature)
    - thiserror 1.x
    - fractional-indexing 3.2.0 (npm)
  patterns:
    - SqliteConnectOptions with WAL mode (journal_mode, synchronous Normal, foreign_keys, busy_timeout, optimize_on_close)
    - SqlitePoolOptions with max_connections(5) — no Mutex needed, SqlitePool is Send+Sync
    - tauri_specta::Builder with export to src/lib/bindings.ts in debug builds
    - block_on bridge for async db init in synchronous tauri::Builder::setup
    - AppState managed via app.manage() with Manager trait in scope
    - Manual sqlx::query() with runtime strings (not compile-time query! macro) — DB path is dynamic
    - NodeType explicit to_db_str()/from_db_str() to guarantee TEXT enum values

key-files:
  created:
    - src-tauri/Cargo.toml
    - src-tauri/tauri.conf.json
    - src-tauri/build.rs
    - src-tauri/src/main.rs
    - src-tauri/src/lib.rs
    - src-tauri/src/db/mod.rs
    - src-tauri/src/db/setup.rs
    - src-tauri/src/db/models.rs
    - src-tauri/src/errors.rs
    - src-tauri/migrations/0001_initial_schema.sql
    - package.json
    - .gitignore
  modified: []

key-decisions:
  - "specta = 2.0.0-rc.22 required (not rc.20 as in docs) — tauri-specta rc.21 depends on specta rc.22"
  - "specta serde_json feature required for serde_json::Value to implement specta::Type"
  - "WAL PRAGMA excluded from migration SQL — set via SqliteConnectOptions only, per plan instructions"
  - "Node.node_type stored as String (not enum) in struct — NodeType enum used for IPC layer only"
  - "fractional-indexing 3.2.0 (latest) installed — research docs referenced older version range"

patterns-established:
  - "Pattern: init_db with WAL mode via SqliteConnectOptions (not PRAGMA in migration)"
  - "Pattern: AppState with SqlitePool directly (no Mutex wrapping)"
  - "Pattern: tauri_specta::Builder export in debug builds only"
  - "Pattern: NodeType explicit string conversion methods for DB round-trips"

requirements-completed: [INFR-02, INFR-04]

duration: 7min
completed: 2026-03-24
---

# Phase 1 Plan 1: Storage Foundation Summary

**Tauri v2 + SQLite foundation with WAL mode, fractional-index nodes table, typed Node/NodeType models, and tauri-specta IPC scaffolding**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-24T12:36:33Z
- **Completed:** 2026-03-24T12:43:28Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments

- Tauri v2 project compiles with all dependencies resolved (cargo check passes zero errors)
- nodes table migration defines UUID PK, adjacency list, fractional-index TEXT position, node_type CHECK constraint, metadata JSON
- Node struct and NodeType enum are specta-exportable (serde + specta::Type)
- Database initialization creates file at app_data_dir with WAL mode via SqliteConnectOptions
- AppState + init_db wired correctly into Tauri setup hook

## Task Commits

Each task was committed atomically:

1. **Task 1: Scaffold Tauri v2 project with SQLite dependencies** - `3d94470` (chore)
2. **Task 2: Create SQLite schema, Rust models, and database initialization** - `e5b39d7` (feat)

## Files Created/Modified

- `src-tauri/Cargo.toml` - All Rust dependencies with pinned RC versions
- `src-tauri/tauri.conf.json` - Bundle identifier com.ai-chat.app
- `src-tauri/src/main.rs` - Entry point calling lib::run()
- `src-tauri/src/lib.rs` - AppState, tauri-specta builder, Tauri setup hook
- `src-tauri/src/db/mod.rs` - Module re-exports for db::models and db::setup
- `src-tauri/src/db/setup.rs` - init_db with WAL mode configuration
- `src-tauri/src/db/models.rs` - Node struct and NodeType enum with serde+specta
- `src-tauri/src/errors.rs` - AppError enum with From<sqlx::Error>
- `src-tauri/migrations/0001_initial_schema.sql` - Complete nodes table schema
- `package.json` - fractional-indexing 3.2.0 npm dependency
- `.gitignore` - Excludes node_modules, dist, target, bindings.ts

## Decisions Made

- **specta rc.22 required:** Research referenced rc.20 but tauri-specta rc.21 actually depends on specta rc.22. Pinned to `=2.0.0-rc.22`.
- **specta serde_json feature:** `serde_json::Value` fields on the Node struct require the `serde_json` feature flag on specta for `specta::Type` to compile.
- **Node.node_type as String:** The struct stores node_type as `String` per plan instructions (not as `NodeType` enum). `NodeType` enum is used at the IPC layer. Manual `to_db_str()` / `from_db_str()` ensure correct TEXT values.
- **WAL excluded from migration:** Per plan specification, WAL is set via SqliteConnectOptions only — including PRAGMA journal_mode in migrations causes issues with `sqlx::migrate!`.
- **fractional-indexing 3.2.0:** Research referenced `^0.1.0` which doesn't exist on npm. Latest stable version 3.2.0 installed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] specta version mismatch — rc.20 incompatible with tauri-specta rc.21**
- **Found during:** Task 1 (cargo check)
- **Issue:** Research specified `specta = "=2.0.0-rc.20"` but tauri-specta rc.21 requires specta rc.22
- **Fix:** Updated Cargo.toml to `specta = "=2.0.0-rc.22"`
- **Files modified:** src-tauri/Cargo.toml
- **Verification:** cargo check passes
- **Committed in:** 3d94470 (Task 1 commit)

**2. [Rule 2 - Missing Critical] Added specta serde_json feature for Value fields**
- **Found during:** Task 2 (cargo check after writing models.rs)
- **Issue:** `serde_json::Value` does not implement `specta::Type` without the `serde_json` feature on specta
- **Fix:** Added `"serde_json"` to specta features in Cargo.toml
- **Files modified:** src-tauri/Cargo.toml
- **Verification:** cargo check passes, all three Node fields using Value compile
- **Committed in:** e5b39d7 (Task 2 commit)

**3. [Rule 2 - Missing Critical] Added specta-typescript crate**
- **Found during:** Task 1 (cargo check — tauri-specta API discovery)
- **Issue:** tauri-specta rc.21 uses new Builder API requiring `specta-typescript` crate for `Typescript::default()` exporter
- **Fix:** Added `specta-typescript = "0.0.9"` to Cargo.toml
- **Files modified:** src-tauri/Cargo.toml
- **Verification:** cargo check passes, builder.export compiles
- **Committed in:** 3d94470 (Task 1 commit)

**4. [Rule 3 - Blocking] fractional-indexing version corrected**
- **Found during:** Task 1 (npm install failure)
- **Issue:** Research referenced `^0.1.0` which does not exist in the npm registry
- **Fix:** Installed `^3.2.0` (latest available stable version)
- **Files modified:** package.json
- **Verification:** npm install succeeds, package present in node_modules
- **Committed in:** 3d94470 (Task 1 commit)

**5. [Rule 3 - Blocking] Created RGBA icon.png for tauri::generate_context!**
- **Found during:** Task 1 (cargo check)
- **Issue:** `tauri::generate_context!()` macro requires an icon file; tauri.conf.json referenced `icons/icon.png` which didn't exist, and the icon must be RGBA format
- **Fix:** Generated minimal 64x64 RGBA PNG via Python, added to src-tauri/icons/icon.png
- **Files modified:** src-tauri/icons/icon.png, src-tauri/tauri.conf.json
- **Verification:** cargo check passes without icon errors
- **Committed in:** 3d94470 (Task 1 commit)

---

**Total deviations:** 5 auto-fixed (1 bug, 2 missing critical, 2 blocking)
**Impact on plan:** All fixes were necessary for correctness and compilation. No scope creep — all changes directly support the stated deliverables.

## Issues Encountered

- tauri-specta rc.21 API differs from RESEARCH.md documentation (uses `Builder` pattern and `specta-typescript` crate, not `ts::builder::<Typescript>()` pattern). Resolved by reading tauri-specta source docs directly.
- Greenfield project required creating icon file — not mentioned in plan but required by Tauri build tooling.

## Next Phase Readiness

- Foundation complete — all types, database initialization, and IPC scaffolding ready
- Plan 02 can immediately add `#[tauri::command] #[specta::specta]` IPC handlers using `AppState` and `Node`/`NodeType` types
- `src/lib/bindings.ts` will be auto-generated by tauri-specta on first `cargo run --dev`

---
*Phase: 01-storage-foundation*
*Completed: 2026-03-24*
