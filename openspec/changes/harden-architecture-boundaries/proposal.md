## Why

A review of the whole codebase (desktop frontend, Rust native layer, server, shared packages and sidecar) found the design sound but several boundaries enforced only by convention. The same business rule is written twice and has drifted, errors cross every process boundary as text that the other side pattern-matches, the sidecar wire format has no shared definition, and the modules that hold the most important policies (undo grouping, remote projection, run admission) can only be tested by booting the whole application. Six defects that review found are already fixed; this change covers the structural causes so the same classes of defect stop recurring.

## What Changes

- **Server rules in one place.** Capture, automation admission, event acceptance, result commit and placement become pure domain functions used by both the in-memory and PostgreSQL repositories, checked by one contract suite that runs against both. The push conflict check moves fully inside the write transaction.
- **Durable dispatcher classification.** A capture whose policy needs a dispatcher model records a durable classification job in the capture transaction; the worker classifies and admits. The capture response no longer waits for a model call.
- **Typed errors at every boundary.** Tauri commands and HTTP routes return `{ code, message }`; callers branch on `code`. **BREAKING (internal):** the desktop stops matching error text, and the server's lease-lost and cancelled conditions get their own codes.
- **One sidecar IPC contract.** Commands, the run payload and events are zod schemas in a shared package, used by both encoder and decoder. Invalid payloads are rejected, not repaired. The five hand-written JSONL clients share one process transport.
- **Migration ledgers.** The server records applied migrations and runs each once under an advisory lock; SQLite tracks `PRAGMA user_version`.
- **Targeted structural edits.** Indent, outdent, move, duplicate, trash and restore emit steps sized to the edit instead of replacing the whole document.
- **Enforced module boundaries.** Import-direction tests for the desktop, a single native adapter layer, per-package typecheck with explicit libs, package-name imports only, and one declared test environment per project.
- **Responsive native storage.** Storage commands run off the main thread, asset bytes cross IPC as binary, event reads are paginated, and server connection changes are atomic.
- **Extract policy out of React.** Undo grouping, remote projection apply, sync scheduling, skill-run dispatch and server provisioning move into plain modules with injected dependencies.
- **Split oversized modules along existing seams** (`persistence.rs`, `sync_commands.rs`, `app.ts`, `skillExecution.ts`, `settingsStore.ts`, `agent-runtime` contracts, `run-turn.ts`, `extension-host/runtime.ts`, `style.css`) without changing behavior.
- **Remove dead code**: the in-webview agent loop and tool executors, `runSkillIntoEditor`, the legacy server engine and `runAgent`, unused schema.
- **Run extension tools behind the executor boundary** so extension code never shares a process with model credentials.

## Capabilities

### New Capabilities

- `server-repository-parity`: one implementation of each server outline rule, a shared contract suite for every repository, and a single transactional push conflict check.
- `capture-automation-dispatch`: durable, lock-free dispatcher classification for Inbox captures.
- `typed-boundary-errors`: stable error codes across native IPC and the HTTP API.
- `sidecar-ipc-contract`: a shared, validated schema for sidecar commands, payloads and events, and one transport.
- `schema-migration-ledgers`: recorded, once-only, ordered migrations for PostgreSQL and SQLite.
- `targeted-structural-edits`: structural outline edits recorded as edit-sized steps.
- `enforced-module-boundaries`: tested import direction, native adapter isolation, per-package typechecking, and extension code isolated from model credentials.
- `responsive-native-storage`: non-blocking native storage commands, binary asset transfer, bounded reads, atomic connection changes.

### Modified Capabilities

None. Existing requirements in `openspec/specs/` keep their behavior; `server-synchronized-outlines` "Stale revision handling" is implemented more strictly (see `server-repository-parity`) but its stated behavior is unchanged.

## Impact

- `apps/server`: `repository.ts`, `postgres.ts`, `agentStore.ts`, `postgresAgentStore.ts`, `app.ts` (route plugins, auth pre-handler, one error handler), `migrate.ts`, a new migration for the ledger and classification jobs, removal of `serverModel.ts` and the `legacy` engine.
- `apps/desktop/src`: `App.tsx`, `application/OutlineSession.ts`, `editor/outlineModel.ts`, `agent/` (skill execution, sidecar clients, dead code), `store/settingsStore.ts`, `components/Settings/ComputeSettings.tsx`, a new `native/` adapter directory, `style.css`.
- `apps/desktop/src-tauri`: `persistence.rs` split into a module directory, `sync_commands.rs` reduced to adapters over a new `ServerClient`, a serializable `CommandError`, async commands, `page_peek.rs`/`shortcuts_key.rs` regrouped, capability scoping.
- `packages/`: sidecar schemas in `protocol`, `agent-runtime` split and renamed to contracts, `pi-runtime/run-turn.ts` and `extension-host/runtime.ts` decomposed, per-package `tsconfig.json`, vitest projects at the root.
- Sidecar: extension tools and hooks run through the executor process protocol.
- Docs: `AGENTS.md` agent flow, `docs/architecture.md`, `docs/server-backend.md`, `docs/extensions.md`, and new ADRs for boundary errors, the sidecar contract and capture classification.
- No change to the document model, event format, or the HTTP API's success responses. Error response bodies keep their shape and gain codes.
