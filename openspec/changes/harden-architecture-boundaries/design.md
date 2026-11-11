## Context

A four-part review (desktop frontend, Rust native layer, server, shared packages and sidecar) confirmed the core design holds: no package cycles, no `any` escapes, every HTTP route schema-validated, parameterized SQL, pinned transport, verified assets, an isolated executor process. The problems are at the seams between parts.

Six defects were fixed before this change and are not repeated here: a lock-order inversion between outline and projection, an unhandled rejection in the agent worker, a model call inside the capture transaction (moved after commit, still awaited), a cancelled run that stayed `running` after its worker died, the model credential left in the run sidecar's environment, and a failing workspace boundary test that the default test command did not run.

What remains is structural. Evidence, by area:

- **Server.** `InMemoryServerRepository` and `PostgresServerRepository` each implement capture, admission, acceptance, commit and placement. They differ on attempt limits (`postgres.ts` admission versus `agentStore.ts`), duplicate-batch handling, version checks, asset checks and source caps. HTTP tests use only the in-memory one. `app.ts` has 35 routes with hand-written auth and error mapping. Push staleness is checked outside the write transaction with a different wire shape than the in-transaction check. Migrations re-run on every start.
- **Native.** All 40 storage commands are synchronous. 126 functions return `Result<_, String>` and the frontend matches the text. `sync_commands.rs` helpers take `State<NativeState>` and are nearly untested. `EventStore` spans five domains in one 1,367-line file. Enrollment and disconnect are multi-step and not atomic.
- **Frontend.** `outlineModel.ts` replaces the whole document for six structural operations. `App.tsx` owns undo grouping and remote projection in closures. `OutlineSession.synchronize` coalesces callers and drops the second caller's projection callback; `App.tsx` adds its own lock with a 25 ms polling wait. Skill runs from outside the slash menu travel through a window event only `SlashMenu` hears. `@tauri-apps` is imported in 30 files. Several directory cycles exist. Roughly 1,500 lines of agent code have only test callers.
- **Packages and sidecar.** `RunPayload` is declared on both sides and decoded by cast with silent repair. Five JSONL clients reimplement framing with different limits. `agent-runtime` exports 207 symbols across contracts, extension schemas and a second agent loop used only by the server's `legacy` engine. Four packages have no type configuration and are compiled by the applications under DOM types. Extension tools load into the process that holds every secret.

## Goals / Non-Goals

**Goals:**

- Each rule, schema and error code has one definition.
- Boundary violations fail a test.
- Policy modules are testable without booting the application.
- The interface does not block on storage, and a capture does not block on a provider.

**Non-Goals:**

- Changing the document model, the event envelope, or the one-document TipTap design.
- Changing HTTP success responses or the sync protocol version.
- New user-facing features.
- Replacing zustand, Fastify, rusqlite or vitest.
- Multi-user access or a different trust model for extensions beyond process isolation.

## Decisions

### 1. Pure domain functions plus thin repositories, not a shared base class

Extract `planCapture`, `planAutomationAdmissions`, `planEventAcceptance`, `buildResultCommittedEvent` and `planPlacement` into `apps/server/src/domain/`. Each takes loaded state and returns events, admissions and errors. Repositories load, call, persist.

A shared abstract repository was considered. It keeps the two implementations coupled through inheritance and still lets SQL-side rules creep in. Functions are easier to test and make the persistence port small.

The in-memory repository stays: it is the fast path for HTTP tests. The contract suite (`describe.each`) is what stops it drifting.

Open product question folded in here: whether an MCP-tool run on the durable runtime gets one attempt or the configured maximum. The stores say the maximum; the PostgreSQL capture path and one contract test say one. The domain function will encode one answer; see Open Questions.

### 2. Split the repository port

`ServerRepository` becomes `TokenAuthenticator`, `OutlineSyncStore`, `AssetCatalog`, `NotesStore` and `AgentStore`. `AgentStore` gains transaction-accepting primitives so outline writers stop writing agent tables with raw SQL. Every run read takes an outline identifier.

### 3. Classification as a queued job, reusing the run queue

A capture that needs a dispatcher inserts a `capture_classifications` row in the capture transaction. The existing worker claims it with the same lease pattern as runs, calls the classifier, and admits runs idempotently on the existing `(outline_id, trigger_identity)` key.

Alternatives: keep the current awaited post-commit call (loses automation if the process dies in the window, and the request waits up to 15 seconds); or admit a normal run whose first step classifies (mixes two lifecycles and shows a phantom run in history). A small dedicated table is the least surprising.

### 4. One error shape per boundary

- Rust: `CommandError { code, message }` with `Serialize` and `From` for `StoreError`, `AssetError`, `TransportError`. Relayed server errors keep the server's code in a `server_code` field.
- Server: one `DomainError` hierarchy carrying `{ code, httpStatus, retryable, recoveryAction }`, mapped in Fastify's `setErrorHandler`. This removes the per-route `try/catch`.
- Frontend: a `nativeError(error)` helper returns the code; `includes(...)` on messages is deleted.

Codes are added to `packages/protocol` so both sides share the union.

### 5. Sidecar schemas live in `packages/protocol`

`protocol` is already isomorphic and already depends on the contracts package. `sidecar.ts` holds a discriminated union for commands, the run payload, and events. `encodePayload` and `decodePayload` both use it. The base64url envelope stays.

Rejecting instead of repairing is a behavior change only for malformed input, which today produces a run with a fabricated identifier.

### 6. One `SidecarProcess` transport

A single class owns `Command.create`, line framing with a declared byte cap, request correlation, timeout, abort and kill. The five clients become protocol wrappers of 30–60 lines. Module-level state in the OAuth client moves into an instance.

### 7. Migration ledgers

- PostgreSQL: `schema_migrations(name, checksum, applied_at)`, `pg_advisory_lock`, one transaction per file. On first run against an existing database, all present files up to the detected state are recorded without execution. Detection uses the newest object each migration creates.
- SQLite: `PRAGMA user_version` with an ordered `(version, sql)` list. The current substring test for migration 0004 becomes the one-time derivation for databases at version 0.

### 8. Structural edits as transforms

Replace `dispatchDocument`'s whole-range `replaceWith` with per-operation transforms: `sinkListItem`/`liftListItem` equivalents for indent and outdent, `tr.delete` plus `tr.insert` at mapped positions for move, trash and restore, `tr.insert` for duplicate. All in one transaction so identity assignment still happens once at the canonical commit boundary.

This is the riskiest item. The 2,350 lines of `outlineStructure.test.ts` and `outlineModel.test.ts` assert resulting documents and stay unchanged; new tests assert step size and rebase behavior. Operations migrate one at a time behind the same public functions.

Event format is unchanged: events already carry arbitrary ProseMirror steps. Old events with whole-document steps still replay.

### 9. Policy out of `App.tsx`

- `HistoryRecorder` (React-free class): owns persistent history and the active change group; `record(tr, appended, context)`, `undo`, `redo`, `reset`.
- `applyRemoteProjection(editor, projection, history)`: function.
- `OutlineSession` gains the single sync queue and `onProjection(callback)`; the scheduler (timers, focus, online, stream) moves into it. `App.tsx`'s lock and polling wait are deleted.
- `SkillRunController`: `start(request)`, `cancel(runId)`, subscribable; requests carry `skillId`. The window event is removed.
- `ServerProvisioningController` for `ComputeSettings.tsx`.

`App.tsx` keeps wiring and rendering. `App.test.tsx` shrinks as tests move to the units.

### 10. Desktop layering and the native adapter

Declared order, lowest first: `lib` → `native` → `persistence`, `sync` → `editor` → `application` → `agent` → `store` → `workspace` (state) → `components`. An import-scan test, modeled on the existing `nativeCommands.test.ts`, enforces it and the `@tauri-apps` allowlist.

Moves that make it true: activity types to `agent/activity.ts`; `normalizedUrl`, `fetchWithTimeout`, `validatePublicWebUrl` to `lib/`; `OutlinePane` and `PaneActions` to `components/`; `LinkPreviewCard` rendering injected into `editor/linkCard`.

### 11. Native layer shape

- `persistence/{mod,schema,events,checkpoints,config,credentials,agent_runs}.rs`, each an `impl EventStore` block; the public API is unchanged so the 22 integration tests keep passing.
- `server_client.rs`: `ServerClient { http, pinned, token, outline_id }` over `&EventStore` and `&AssetStore`. Commands become adapters. Tests use a local `TcpListener` stub, as `examples/workspace.rs` already does.
- Storage commands become `#[tauri::command(async)]` with blocking work on the blocking pool. `asset_read` returns `tauri::ipc::Response`.
- `enum AgentRunStatus` with `is_terminal()` and `is_retryable()`; SQL `IN` lists are generated from it.
- `bootstrap::native_state(app_data)` shared by `run()` and the examples.

### 12. Packages

- Rename `agent-runtime` to `agent-contracts` after deleting `runAgent`, `composeAgentPrompt` and the model adapter types with the `legacy` engine. Split `contracts.ts` and `extensions.ts` along their existing sections; extension schemas move next to `extension-api`.
- Every package gets `tsconfig.json` with explicit `lib` and `types`, and a `typecheck` script. Applications drop `../../packages` from `include`.
- Root vitest `projects` replace the hand-synchronised exclude list and turbo filter list.
- `runPiTurn` is decomposed into extension construction, run open-or-recover, event bridging and lifecycle journaling; persisted outcomes are schema-parsed.
- `structuredResultFromOutline` moves into `pi-runtime` so server and sidecar share the conversion and limits.

### 13. Extension tools through the executor process

The executor worker protocol already isolates executors with an allowlisted environment and scoped secrets. Add `tool`, `run:start` and `run:end` operations and route tool and hook calls through it. The run sidecar stops importing extension entry code.

Cost: one process hop per tool call. Extension tools are already I/O-bound, so this is acceptable. The earlier fix (scrubbing the environment) remains as defense in depth.

### 14. Order of work

Phases are independently shippable and ordered by risk reduction per effort:

1. Guard rails: import-direction test, vitest projects, per-package typecheck, dead-code removal. These make later phases safer.
2. Contracts: error codes, sidecar schemas, migration ledgers.
3. Server: domain functions, contract suite, port split, route plugins, classification jobs.
4. Native: module split, `ServerClient`, async commands, atomic connection changes.
5. Frontend extraction: history, sync queue, skill-run controller, provisioning, native adapter.
6. Structural edits.
7. Extension tool isolation, package rename, CSS split.

## Risks / Trade-offs

- **Structural edit regressions corrupt user outlines** → migrate one operation at a time; keep document-equality tests; add property tests comparing the transform result with the old whole-document result on generated outlines; ship behind a development flag for one release.
- **Error code change breaks an unlisted text match** → grep for `.includes(` and regex tests on error values before removing messages; keep messages unchanged in the release that adds codes, remove matching in the next.
- **Migration ledger mis-detects an existing database** → detection is read-only and covered by a test per historical schema state; on ambiguity, stop with an error instead of guessing.
- **Async native commands reorder writes** → SQLite access stays behind the single connection mutex; `append_event` ordering is covered by the existing outbox tests, plus a new concurrent-append test.
- **Contract suite needs PostgreSQL to be meaningful** → it still runs in-memory by default; document that CI must set `TEST_DATABASE_URL`, since no CI configuration exists yet.
- **Large change, long-lived branch** → no single branch: each phase lands separately, and every task leaves `pnpm build` and `pnpm test` passing.
- **Renaming `agent-runtime` touches many imports** → last phase, mechanical, one commit.
- **Extension tool hop adds latency** → measure on the reference extension; keep the worker warm for the run's duration.

## Migration Plan

- No data migration for outlines or events.
- PostgreSQL: one new migration adds `schema_migrations` and `capture_classifications`. The ledger bootstrap runs once at first start. Rollback: the previous build ignores both tables.
- SQLite: `user_version` is set on first open; older builds ignore it. A database later migrated past what an older build knows is refused by newer builds only, so downgrade remains possible until the next schema change.
- Unused schema (`asset_cache`, `provisioning_steps`, two `agent_runs` columns) is dropped in a later migration, after one release in which nothing references it.
- The `legacy` engine and `FORAGE_AGENT_ENGINE` are removed; setting the variable to `legacy` fails startup with a clear message.

## Open Questions

- Attempt limit for MCP-tool runs on the durable runtime: one, or the configured maximum? Needed before Decision 1's admission function is written.
- Should dropping the unused server schema wait for a release, or go with the ledger migration?
- Is there appetite for a CI workflow in this change? Several requirements assume the default test command runs somewhere on every change.
- CSS: split `style.css` per feature in this change, or track separately as a design-system task? It is mechanical but large, and overlaps the unarchived `redesign-settings` change.
