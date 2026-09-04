# Forage Roadmap

This roadmap tracks the current product and operational workstreams. It intentionally avoids preserving obsolete implementation phases; architectural history belongs in the ADRs.

## 1. Core outliner quality

**Foundation implemented:** one ProseMirror document, stable bullet identity, keyboard editing, structural operations, zoom, search, tags, internal links, rich content, and document-native undo.

**Current direction:**

- Keep the outliner fast and predictable as document size and structural depth grow.
- Close interaction and accessibility gaps in keyboard navigation, selection, drag/reorder, search, and command composition.
- Keep user and agent changes understandable through provenance, activity, and reliable undo/redo.

## 2. Local durability and upgrade safety

**Foundation implemented:** SQLite event storage, deterministic replay, checkpoints, hash verification, persistent history, crash-recovery coverage, event versions, upcasters, and schema-epoch machinery.

**Current direction:**

- Exercise backup and restore from a clean application-data directory.
- Implement and verify the first real document-schema epoch migration before an incompatible schema change ships.
- Define retention and permanent-erasure behavior for immutable history and unreferenced assets.
- Keep replay fixtures representative across supported application versions.

## 3. Optional synchronization and server operation

**Foundation implemented:** PostgreSQL authority, device enrollment, authenticated pull/push, offline outbox, step rebase, explicit conflict state, scoped capture tokens, and content-addressed asset transfer.

**Current direction:**

- Complete an operator-tested PostgreSQL and asset backup/restore procedure.
- Improve conflict diagnosis and recovery without introducing silent last-writer-wins behavior.
- Test multi-device outage, reconnect, credential rotation, and server-upgrade paths.
- Add operational visibility needed for a self-hosted one-owner deployment.

The server remains optional; local mode must continue to work independently.

## 4. Agent workflows

**Foundation implemented:** configurable agents and skills, explicit context construction, bounded tools, local Pi SDK execution, durable server execution, activity reporting, cancellation, structured outline insertion, Inbox automation, and webpage/X/YouTube ingestion adapters.

**Current direction:**

- Make one end-to-end research and organization workflow exceptionally clear and reliable.
- Preserve equivalent run, activity, result, policy, and provenance contracts across local and server executors.
- Improve failure recovery, retry, cancellation, and credential reauthorization UX.
- Keep external material labelled untrusted and tool access deny-by-default.

## 5. Distribution and production readiness

**Current direction:**

- Bundle and pin the required Node.js, sidecar, and Codex runtimes for signed macOS distribution.
- Verify hardened-runtime, signing, notarization, first-launch, upgrade, and runtime-diagnostic behavior.
- Document supported macOS and dependency versions.
- Treat production durability as incomplete until restore procedures have been exercised successfully.

## Architectural history

- ADR-0001's thin-shell restriction and ADR-0004's iCloud JSON persistence were superseded by [ADR-0012](../docs/ADRs/ADR-0012-event-store-and-optional-server.md).
- ADR-0008's `pi --mode rpc` process was superseded by the embedded SDK sidecar in [ADR-0013](../docs/ADRs/ADR-0013-embedded-pi-sdk-sidecar.md).
- The current system map and authority rules live in [docs/architecture.md](../docs/architecture.md).

---

*Last updated: 2026-09-04*
