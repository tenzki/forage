## Why

Forage currently persists one whole ProseMirror document to an iCloud JSON file, which does not provide durable event history, safe multi-writer synchronization, or an API that other applications can use to add notes. An optional self-hosted backend will let one owner use the same outline across machines and integrate external applications while preserving offline editing through a local cache.

## What Changes

- Replace snapshot-only local persistence with an event-sourced SQLite store containing accepted and pending events, checkpoints, and synchronization state while keeping the ProseMirror document as the editor model.
- Add explicit `local` and `server` storage modes. Local mode is single-device; server mode uses the local SQLite store as an offline cache and outbox while PostgreSQL is authoritative.
- Add a PostgreSQL-backed server that assigns a total revision order per outline, stores immutable events and rebuildable checkpoints/projections, and synchronizes bounded event batches with desktop clients.
- Add `POST /api/v1/notes` for scoped external integrations to create plain-text notes, defaulting to a configured Inbox and supporting idempotent retries.
- Add one-owner authentication with full-access desktop device credentials and narrowly scoped, revocable external API tokens.
- Store generated images as content-addressed assets instead of base64 data embedded in documents, events, and checkpoints.
- Version the HTTP API, event payloads, and ProseMirror document schema independently, including compatibility negotiation and explicit schema epochs.
- Capture document changes, trash operations, shortcuts, agent output, undo, and redo as durable events. Snapshots become replay checkpoints rather than a write protocol.
- **BREAKING** Remove iCloud as an active persistence and synchronization backend. There are no existing users, so no legacy-data migration is required.
- **BREAKING** Supersede the thin-shell and iCloud whole-document persistence decisions where they conflict with the local SQLite event store and narrow native synchronization boundary.
- Defer multi-user accounts, general note read/update/delete APIs, browser CORS integrations, automated backup implementation, permanent-erasure policy, and real-time collaborative editing.

## Capabilities

### New Capabilities

- `event-sourced-outline-storage`: Durable local events, checkpoints, projections, undo/redo events, storage modes, and crash recovery in SQLite.
- `server-synchronized-outlines`: PostgreSQL event ordering, offline outbox synchronization, conflict/rebase behavior, authentication, protocol negotiation, and explicit sync status.
- `notes-api`: A versioned and idempotent `POST /api/v1/notes` contract for scoped external applications.
- `content-addressed-assets`: Verified local/server asset storage, references from outline nodes, caching, and conservative retention.

### Modified Capabilities

None. This repository has no existing OpenSpec capability specifications.

## Impact

- Desktop persistence moves out of `src/persistence/outlineFile.ts` and the React state orchestration in `src/App.tsx` into an event store, deterministic projections, and a synchronization state machine.
- TipTap transaction handling must expose complete document-changing step batches, including normalization steps, without persisting selection-only transactions.
- Trash, shortcuts, agent insertion, undo, and redo must dispatch commands/events rather than directly replacing persisted React state.
- The repository gains shared TypeScript domain, document, and protocol modules plus a TypeScript/Node.js server connected to PostgreSQL.
- Tauri gains local SQLite support, secure credential storage, a non-null content security policy, and a narrow native transport for the configured server.
- Generated-image nodes change from embedded data URLs to stable asset identifiers, requiring document-schema migration support before release.
- Existing iCloud filesystem capabilities, legacy migrations, obsolete SQL migrations, and stale SQLite/Rust tests can be removed because there are no deployed users to migrate.
