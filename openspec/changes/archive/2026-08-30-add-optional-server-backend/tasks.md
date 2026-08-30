## 1. Shared Workspace and Contracts

- [x] 1.1 Introduce `apps/desktop`, `apps/server`, domain, document, and protocol workspace boundaries without changing current runtime behavior
- [x] 1.2 Define runtime-validated command and event envelopes with IDs, actors, devices, versions, causal/base revision, origin, and payload types
- [x] 1.3 Extract the canonical non-UI ProseMirror schema and stable bullet-ID rules into the shared document package
- [x] 1.4 Implement shared ProseMirror step serialization, inverse-step capture, application, and rebase helpers
- [x] 1.5 Implement the deterministic outline reducer, checkpoint encoding, integrity hashing, and event upcaster registry
- [x] 1.6 Add shared fixtures proving identical checkpoint-plus-event replay in desktop-compatible and server Node.js runtimes

## 2. Local SQLite Event Store

- [x] 2.1 Add the new local SQLite dependency and create migrations for events, checkpoints, sync state, superseded pending events, and asset-cache metadata
- [x] 2.2 Implement transactional append, ordered read, pending-outbox query, supersession, and server-acknowledgement repository operations
- [x] 2.3 Implement checkpoint creation, integrity verification, compatible-checkpoint selection, and replay after a checkpoint
- [x] 2.4 Implement explicit local and server storage-mode configuration with databases stored under application data
- [x] 2.5 Add crash-recovery tests for an event stored before send, a batch acknowledged during interruption, and a corrupted newest checkpoint

## 3. Desktop Event-Driven Refactor

- [x] 3.1 Capture a complete document-changing ProseMirror dispatch and appended normalization steps as one locally durable event while ignoring selection-only transactions
- [x] 3.2 Replace `App.tsx` whole-document saver ownership with a projected outline store subscribed to the local event repository
- [x] 3.3 Convert trash, restore, purge, and shortcut mutations into validated commands and durable events
- [x] 3.4 Convert agent output insertion into bounded event batches without creating one event per streamed token
- [x] 3.5 Persist inverse steps and change-group metadata and implement undo/redo as compensating events that survive restart
- [x] 3.6 Add desktop integration tests covering typing, normalization IDs, structural editing, trash, shortcuts, agent output, restart replay, undo, and redo

## 4. Local Content-Addressed Assets

- [x] 4.1 Implement a local asset repository that validates PNG, JPEG, and WebP signatures and sizes and addresses verified bytes by SHA-256
- [x] 4.2 Change generated-image document nodes from data URLs to `assetId` plus bounded alt text
- [x] 4.3 Route generated-image output through local asset ingestion before appending an asset-reference event
- [x] 4.4 Implement local URL resolution, cache lookup, and the recoverable unavailable rendering state for missing offline bytes
- [x] 4.5 Add tests for hash verification, deduplication, unsupported SVG, oversize rejection, offline rendering, and missing cached content

## 5. PostgreSQL Server Foundation

- [x] 5.1 Scaffold the TypeScript/Node.js server with validated configuration, PostgreSQL connectivity, structured redacted logging, and separate liveness/readiness endpoints
- [x] 5.2 Add PostgreSQL migrations for owners, outlines, immutable events, checkpoints, projections, device credentials, API tokens, idempotency records, and asset metadata
- [x] 5.3 Implement one-owner bootstrap and creation of the initial outline and configured API Inbox
- [x] 5.4 Implement row-locked transactional event acceptance with contiguous per-outline revisions and atomic projection updates
- [x] 5.5 Implement checkpoint generation and verification from the shared reducer
- [x] 5.6 Add database contract tests for concurrent acceptance, duplicate event IDs, stale bases, rollback on projection failure, and immutable accepted events

## 6. Server Synchronization Protocol

- [x] 6.1 Implement authenticated checkpoint bootstrap with document-version compatibility checks
- [x] 6.2 Implement bounded, paginated event pull after an acknowledged revision
- [x] 6.3 Implement bounded event push with idempotent acknowledgement mappings and structured `rebase_required` responses
- [x] 6.4 Add protocol schemas and error codes for authentication-required, upgrade-required, conflict, request bounds, and unavailable dependencies
- [x] 6.5 Add integration tests for bootstrap, pagination, retry, stale revision, batch limits, and checkpoint refresh after retained history

## 7. Authentication and Native Transport

- [x] 7.1 Implement high-entropy named device and API tokens with hashed server storage, scopes, optional expiration, last-used metadata, and revocation
- [x] 7.2 Implement one-time token display and authorization checks that do not disclose cross-outline resource existence
- [x] 7.3 Store desktop device credentials in OS-backed or encrypted credential storage and keep only a credential reference in normal settings
- [x] 7.4 Add narrow native commands for connection testing, checkpoint transfer, event pull/push, and asset transfer
- [x] 7.5 Enforce configured-origin pinning, server-instance verification, system TLS, loopback-only HTTP, redirect rejection, timeouts, and payload bounds
- [x] 7.6 Add a non-null desktop content security policy and tests that unconfigured origins cannot receive authenticated synchronization requests

## 8. Desktop Synchronization State Machine

- [x] 8.1 Implement the explicit local-only, offline, connecting, syncing, up-to-date, conflict, authentication-required, upgrade-required, and server-unavailable states
- [x] 8.2 Implement new-device bootstrap from a compatible checkpoint and later events
- [x] 8.3 Implement event pull, local replay, push, and transactional acknowledgement recording
- [x] 8.4 Implement deterministic rebase and durable supersession for safely transformable pending ProseMirror events
- [x] 8.5 Implement automatic merging for independent domain events such as distinct `note.created` events
- [x] 8.6 Implement conflict preservation and user-visible recovery when both intentions cannot be safely transformed
- [x] 8.7 Add end-to-end tests for offline editing, reconnect, external changes during editing, authentication expiry, incompatible schema, and conflict recovery

## 9. External Notes API

- [x] 9.1 Define the versioned request and response schemas for `POST /api/v1/notes` and enforce plain-text and metadata bounds
- [x] 9.2 Implement `notes:create` authorization and token-to-outline resolution
- [x] 9.3 Implement default Inbox insertion and explicit validation of caller-supplied stable parent IDs
- [x] 9.4 Implement required token-scoped idempotency keys, replay of the original result, and rejection of key reuse with different input
- [x] 9.5 Generate the server-assigned note ID and canonical `note.created` event in the same transaction as projection and idempotency updates
- [x] 9.6 Return `201 Created`, the note location, event ID, revision, resolved parent, provenance, and timestamp
- [x] 9.7 Add API tests for successful creation, retry, invalid token/scope, invalid parent, oversized text, raw HTML/JSON, nested content, and unsupported assets
- [x] 9.8 Add an end-to-end test proving an externally created note appears with the same identity and parent on a synchronized desktop

## 10. Server Asset Storage and Synchronization

- [x] 10.1 Implement the server filesystem asset backend behind a storage interface and use deterministic hash-based storage keys
- [x] 10.2 Implement authenticated upload initiation/completion and download with independent hash, media-signature, ownership, and size verification
- [x] 10.3 Reject outline events that reference unknown, incomplete, or unauthorized assets without advancing revision
- [x] 10.4 Implement desktop upload of missing local assets and authenticated download into the local content-addressed cache
- [x] 10.5 Implement conservative reference-aware retention that never removes assets referenced by retained live state, trash, events, or checkpoints
- [x] 10.6 Add integration tests for upload deduplication, interrupted upload, forged hashes, unauthorized access, atomic event rejection, caching, and offline rendering

## 11. Compatibility and Schema Epochs

- [x] 11.1 Implement the server status response with instance ID, API versions, event versions, document schema version, and minimum client version
- [x] 11.2 Implement client connection negotiation and safe write refusal for unsupported versions
- [x] 11.3 Implement event upcasting tests for every retained event version
- [x] 11.4 Implement document schema migration as verified old checkpoint, migrated checkpoint, `document.schema_migrated` event, and new epoch
- [x] 11.5 Add tests proving unknown future events are rejected without advancing acknowledgement and new epochs replay from their migration checkpoint

## 12. Cleanup, Decisions, and Verification

- [x] 12.1 Remove iCloud outline persistence, legacy identity migration, iCloud filesystem capabilities, and obsolete snapshot-saver tests after SQLite parity is verified
- [x] 12.2 Remove stale pre-replatform SQL migrations, Rust database tests, and comments that describe the abandoned node-table architecture
- [x] 12.3 Add an ADR superseding the thin-shell and iCloud whole-document persistence decisions with the event-store and optional-server architecture
- [x] 12.4 Document local single-device mode, server mode, initial one-owner limitations, API token usage, operational limitations, and the deferred backup work in `docs/backing-up-pq.md`
- [x] 12.5 Run shared unit tests, desktop integration tests, PostgreSQL integration tests, API tests, synchronization end-to-end tests, TypeScript checks, production builds, and packaged Tauri smoke tests
- [x] 12.6 Validate all OpenSpec requirements against test evidence and record any intentionally deferred requirement as a follow-up change before completion
