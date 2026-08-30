## Context

Forage is currently a Tauri desktop application whose complete outline is one TipTap/ProseMirror document. `App.tsx` owns live document, trash, and shortcut state and schedules debounced replacement of an iCloud `tree.json` envelope. ProseMirror history is the only undo stack, generated images are embedded as base64 data URLs, and the Tauri HTTP capability permits only a fixed set of service origins.

The new capability must preserve the single ProseMirror document as the editing model while adding durable change history, offline operation, optional multi-machine synchronization through a self-hosted server, and a stable API for other applications to add notes. There are no deployed users, so compatibility with the existing iCloud file and legacy database schema is not required.

The initial server has one owner and one or more devices and API tokens. PostgreSQL is the authoritative server store. The desktop continues to work without a server in local mode and continues to work temporarily without connectivity in server mode.

## Goals / Non-Goals

**Goals:**

- Represent every persisted outline change as an immutable, versioned event.
- Keep the ProseMirror document as the editor and document model instead of restoring relational per-bullet editing state.
- Persist local events, checkpoints, and synchronization metadata transactionally in SQLite.
- Make PostgreSQL authoritative in server mode while retaining a durable offline cache and outbox on each desktop.
- Synchronize event batches without silent last-writer-wins replacement.
- Let scoped external applications create notes through `POST /api/v1/notes`.
- Store generated images as verified, content-addressed assets.
- Share event, document, migration, and protocol behavior between the TypeScript desktop and TypeScript server.
- Protect server credentials behind a narrow native boundary and expose clear synchronization state to the user.

**Non-Goals:**

- Multi-user registration, invitations, teams, or per-note sharing.
- Real-time collaborative cursors or a CRDT-based editor.
- General external note listing, searching, updating, deleting, moving, or rich-text creation.
- Active iCloud persistence or synchronization.
- Migration of existing iCloud or legacy SQLite data.
- Automated production backups, point-in-time recovery, or PostgreSQL replication in this change.
- Permanent-erasure and backup-retention policy.
- Browser integrations requiring permissive CORS.

## Decisions

### 1. Use explicit local and server storage modes

Local mode uses the local SQLite event store as the authority and makes no synchronization requests. It is intentionally single-device. Server mode treats PostgreSQL as authoritative and uses SQLite as a local checkpoint cache and durable outbox. The active database is stored in application data, not iCloud Drive.

This avoids running two independent synchronization systems. A remote-only client was rejected because server outages must not prevent reading or editing cached notes. Simultaneous iCloud and server authority was rejected because it cannot provide one reliable event order.

### 2. Persist atomic events, not debounced document replacements

Every state-changing command produces one or more immutable events. Document edits use serialized ProseMirror steps and inverse steps. A complete editor dispatch, including normalization transactions such as stable bullet-ID assignment, is captured as one atomic `document.steps_applied` event. Selection-only transactions are not persisted.

Trash, restore, purge, shortcut, note creation, agent insertion, asset reference, undo, and redo operations pass through the same command/event boundary. Agent streaming may group visible deltas over a short bounded interval to avoid one event per token. Network sending may be debounced or batched; local event durability may not be debounced.

Undo and redo append compensating events instead of mutating history. Consecutive typing events carry a common change-group identifier so one user undo action can reverse a normal typing burst. Inverse steps are captured while the pre-change document is available, allowing undo history to survive restart.

### 3. Use checkpoints as replay accelerators

SQLite and PostgreSQL store periodic document checkpoints associated with the last included local sequence and, where applicable, server revision. Startup loads the latest verified compatible checkpoint and replays later events. A checkpoint is a derived projection and never authorizes overwriting newer events.

Checkpoint integrity hashes detect corruption and support server/client projection comparison. Checkpoint cadence is implementation-tunable, but creation must not block normal typing for an unbounded interval.

### 4. Use SQLite locally without restoring the old relational node model

The local database stores an append-only event table, verified checkpoints, synchronization state, and asset-cache metadata. It does not normalize every bullet into an authoritative row and does not contain a competing database undo stack. Event append, outbox status changes, acknowledgements, and checkpoint metadata use SQLite transactions.

An unaccepted event may be superseded locally after rebase, but it remains available for recovery until the replacement is durable. An accepted server event is immutable.

### 5. Use PostgreSQL as the authoritative event sequencer

The server stores `outlines`, `outline_events`, `outline_checkpoints`, token metadata, idempotency records, and rebuildable projections. For each accepted batch, the server locks the outline row, validates the base revision and idempotency keys, assigns contiguous revisions, updates derived state, and commits atomically.

The primary event identity is globally unique, while `(outline_id, revision)` defines the authoritative order. The application database role cannot update or delete accepted events during normal operation. Projections may include the current ProseMirror document and note/search views, but they must be rebuildable from a checkpoint and subsequent events.

### 6. Share the domain and document model in TypeScript

The repository will separate desktop, server, and shared packages conceptually as:

```text
apps/desktop
apps/server
packages/domain
packages/document
packages/protocol
```

The domain package contains typed commands, event envelopes, reducers, IDs, and upcasters. The document package contains the canonical ProseMirror schema, step serialization/application, checkpoint encoding, and document migrations. The protocol package contains runtime-validated HTTP request and response schemas. Shared packages cannot depend on React, Tauri, PostgreSQL, or browser-only APIs.

The server uses Node.js/TypeScript so the same deterministic event application and schema code runs on both sides. Rust remains limited to privileged desktop capabilities.

### 7. Synchronize with pull, rebase, and idempotent push

The initial protocol provides checkpoint bootstrap, paginated event pull after a revision, and bounded event push. Each client event carries a client-generated event ID, device ID, base revision, event and document versions, and payload. The server maps accepted event IDs to assigned revisions.

When a client pushes against a stale revision, the server returns `rebase_required` with its current revision and enough information to retrieve missing events. The client applies missing events, rebases its unaccepted steps, durably records replacement events, and retries. Safe domain events such as independent `note.created` operations merge automatically. If rebase cannot preserve both intentions, the client retains both local and server material and enters an explicit conflict state.

Polling is sufficient initially. A later notification stream may announce that a newer revision exists, but event pull remains authoritative.

### 8. Expose a narrow note-creation API

`POST /api/v1/notes` accepts plain text, an optional stable parent note ID, optional source metadata, and an optional client creation timestamp. The authenticated token is bound to an outline. Omitting the parent targets the configured API Inbox. Supplying a missing or deleted parent returns an explicit conflict rather than silently changing caller intent.

The server assigns the note ID and emits `note.created`. Callers cannot submit raw events, ProseMirror JSON, HTML, nested children, or asset data. Inline `#tags` remain part of text in the initial API. `Idempotency-Key` is required and replay returns the original result.

### 9. Start with one owner and scoped tokens

The server bootstraps one owner. Desktop device credentials receive synchronization access to that owner's outline. External API tokens are named, revocable, optionally expiring, bound to an outline where possible, and default to `notes:create`. Only token hashes are stored by the server, and secret values are displayed once.

The desktop stores the device credential in OS-backed or encrypted credential storage and persists only a reference in ordinary settings. The schema retains owner identifiers so multi-user support can be added later without changing event ownership.

### 10. Use a narrow native server transport

Server mode uses native Tauri commands for connection testing, event pull/push, checkpoint transfer, and asset transfer. The native layer pins authenticated requests to the configured origin, rejects cross-origin redirects, applies timeouts and response limits, and does not expose a general arbitrary-origin fetch capability.

HTTPS is required except for loopback development. System TLS verification remains enabled. Initial connection records the server instance ID and supported versions; later connections verify that the configured URL still identifies the same server. The desktop receives a non-null content security policy.

### 11. Store image bytes by verified content hash

Generated images are identified by a SHA-256 content identifier. ProseMirror nodes persist `assetId` and alt text, not base64 bytes, temporary URLs, or local paths. Local mode stores bytes in application data; server mode uploads missing bytes to a server filesystem storage implementation behind an interface that can later support S3-compatible storage.

The server verifies size, declared media type, byte signature, and content hash before marking an upload complete. Only completed owner-accessible assets may be referenced by accepted events. PNG, JPEG, and WebP remain supported with a five-megabyte limit; SVG is rejected. Asset deletion is conservative while retained events, checkpoints, live notes, or trash may reference the content.

### 12. Version API, events, and documents independently

HTTP compatibility is expressed in the `/api/v1` path. Each event carries its event type/version and document schema version. The server status response advertises API versions, supported event versions, current document schema, minimum client version, and server instance ID.

Older event payloads are interpreted through explicit upcasters. Unknown newer versions are rejected. A document schema migration creates a verified old checkpoint, migrates the document, records `document.schema_migrated`, and starts a new schema epoch. Operational replay starts from the epoch checkpoint so future versions do not need to apply every historical ProseMirror step against a different schema.

### 13. Remove iCloud and stale persistence artifacts

Because there are no existing users, the implementation removes the iCloud outline backend, legacy identity migration, iCloud filesystem capabilities, and obsolete pre-replatform SQL migrations/tests instead of maintaining import compatibility. The accepted architecture ADRs for thin Tauri and iCloud JSON persistence must be superseded with a new decision record.

Backup and restore implementation is postponed and recorded separately in `docs/backing-up-pq.md`.

## Risks / Trade-offs

- **[Risk] ProseMirror steps from stale offline clients may not rebase cleanly.** → Preserve unaccepted events, use shared step transformation, automatically merge only proven-safe cases, and expose a conflict state without discarding either version.
- **[Risk] Event volume grows rapidly during typing and agent streaming.** → Persist small atomic changes, batch network transfer, group undo intentions, checkpoint regularly, and bound agent-delta cadence.
- **[Risk] Shared document behavior drifts between desktop and server.** → Run the same TypeScript schema/reducer packages and cross-runtime replay fixtures on both sides.
- **[Risk] A compromised webview could attempt to exfiltrate credentials or notes.** → Keep server secrets and authenticated transport behind a narrow native boundary, pin origins, reject redirects, and enable CSP.
- **[Risk] Event sourcing retains content users believe they deleted.** → Treat trash and purge semantics explicitly and postpone claims of permanent erasure until retention and backup policy is specified.
- **[Risk] PostgreSQL or asset storage loss remains possible.** → Do not claim production durability until the work recorded in `docs/backing-up-pq.md` is implemented and restore-tested.
- **[Risk] The refactor spans editor, persistence, Tauri, server, and assets.** → Introduce the shared reducer and local event store first, preserve runnable checkpoints, and add server mode only after deterministic replay is verified.
- **[Trade-off] Local mode becomes single-device.** → Users who require multi-machine use select server mode; this avoids maintaining an additional peer-to-peer iCloud synchronization engine.

## Migration Plan

There is no user-data migration. Development proceeds behind an unreleased schema boundary:

1. Add shared domain/document/protocol modules and deterministic replay fixtures.
2. Add the local SQLite event store and convert desktop state mutations to commands/events.
3. Add checkpoints, persistent undo grouping, and crash recovery; remove JSON autosave only after parity tests pass.
4. Change generated-image nodes to asset identifiers and add local asset storage.
5. Add the PostgreSQL server, one-owner bootstrap, tokens, and status/version negotiation.
6. Add the native secure transport and desktop sync state machine.
7. Add `POST /api/v1/notes` and end-to-end synchronization tests.
8. Remove iCloud persistence, legacy migration, stale SQL artifacts, and obsolete capabilities.
9. Supersede conflicting ADRs and document operational limitations.

Rollback during development uses source rollback and disposable development databases. After release, database migrations must be forward-safe; server mode must refuse to start against an unsupported newer schema rather than attempting destructive downgrade.

## Open Questions

- Which Node.js HTTP and PostgreSQL libraries will be used by the server?
- Will local SQLite access use the official Tauri SQL plugin directly or a smaller custom Rust repository command surface?
- Which OS-backed credential implementation will be used on macOS and eventual non-macOS targets?
- What checkpoint cadence and retained event window provide acceptable startup time and disk usage under realistic typing and agent workloads?
- Which conflict presentation best preserves both versions without confusing a single owner?
- What explicit trash, purge, event-retention, and permanent-erasure contract will be specified after the initial backend is working?

