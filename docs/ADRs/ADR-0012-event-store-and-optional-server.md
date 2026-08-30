# ADR-0012: Use an Event Store with an Optional Self-Hosted Server

- **Status:** Accepted
- **Date:** 2026-08-30
- **Deciders:** Forage maintainers
- **Supersedes:** ADR-0001 (thin-shell restriction), ADR-0004
- **Superseded by:** None

## Context

Whole-document iCloud JSON persistence could make one outline available on multiple Macs, but it could not sequence concurrent changes, preserve offline intentions, expose an external note-capture API, or safely synchronize content-addressed images. There are no deployed users and no existing data requires migration.

The ProseMirror document remains the correct editing model. The persistence model must record its changes without reintroducing authoritative relational rows per bullet.

## Decision

We will **persist every state change as an immutable event in local SQLite and optionally synchronize those events through a one-owner PostgreSQL server** because **one ordered event vocabulary provides durable offline editing, restart-safe history, explicit conflict handling, and an API surface without creating a second document model**.

The desktop has explicit modes:

- local mode: SQLite in the Tauri application-data directory is authoritative and intentionally single-device;
- server mode: PostgreSQL is authoritative, while SQLite remains the durable cache and pending outbox.

Shared TypeScript packages own runtime event/protocol validation, deterministic reduction, the canonical ProseMirror schema, step inversion, and rebase behavior. Rust owns the narrow privileged boundary: SQLite, local asset bytes, OS credential storage, and origin-pinned authenticated transport. Generated images are referenced by verified SHA-256 IDs; bytes are stored separately.

The initial server has one owner. Scoped, revocable tokens authorize either device synchronization or `POST /api/v1/notes`. Multi-user access, rich external editing, active iCloud synchronization, and production backup automation are outside this decision.

## Consequences

### Positive

- Every durable change, including undo and redo, has immutable identity and provenance.
- Local editing remains available without a server and temporarily during server outages.
- Multiple desktops and external note-capture tools share one authoritative sequence.
- Checkpoints accelerate startup without replacing or authorizing deletion of history.
- Credentials and authenticated server requests stay outside the webview.

### Negative

- The system now spans React, shared TypeScript packages, native Rust, PostgreSQL, and filesystem asset storage.
- Some offline ProseMirror changes cannot be transformed safely and require an explicit conflict state.
- Event history changes the meaning of deletion; permanent erasure needs a future retention policy.
- A self-hosted operator is responsible for PostgreSQL and asset backups.

### Risks and Mitigations

- **Projection drift:** replay the same fixtures in desktop-compatible and Node runtimes and hash checkpoints.
- **Silent overwrite:** reject stale pushes, transform only safe changes, preserve superseded pending events, and expose conflicts.
- **Credential exfiltration:** use OS credential storage, a non-null CSP, pinned origins, no redirects, and narrow native commands.
- **Missing image bytes:** verify hashes and signatures at both boundaries and never accept references to incomplete server assets.

## Implementation Notes

No legacy iCloud or relational database migration is provided. The old iCloud file backend, filesystem capability, and pre-replatform migrations are removed. ADR-0002’s single-ProseMirror-document decision remains accepted; the event store records changes to that model rather than replacing it.

Production backup/restore work is intentionally deferred to [backing-up-pq.md](../backing-up-pq.md).

## Validation

- Shared replay, step inversion/rebase, and upcaster tests pass in browser-compatible and Node environments.
- SQLite crash-recovery and checkpoint-corruption tests pass.
- PostgreSQL tests cover row-locked sequencing, immutability, stale writes, and API idempotency.
- Desktop/server protocol, native transport, asset, and synchronization tests exercise bounded authenticated paths.

## References

- [OpenSpec change](../../openspec/changes/add-optional-server-backend/proposal.md)
- [Server operation and Notes API](../server-backend.md)
