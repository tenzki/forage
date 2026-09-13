# ADR-0015: Seed the Server Outline From the First Desktop

- **Status:** Accepted
- **Date:** 2026-09-12
- **Deciders:** Forage maintainers
- **Supersedes:** None
- **Superseded by:** None

## Context

ADR-0012 made PostgreSQL authoritative in server mode and stated that "no deployed users and no existing data requires migration", so no local-to-server import path was built. `bootstrapOwner` consequently created an outline with its own genesis content: an Inbox node, a Daily Notes node, one empty bullet, a revision-0 projection, and a genesis checkpoint.

A desktop that had been used in local mode therefore met a server that already had a history. The two event streams cannot be reconciled: each carries revisions and base revisions meaningful only within its own stream, and the conflict model deliberately refuses to merge divergent histories. Connecting parked the user's local outline and adopted the server's empty stub instead. The data the user actually cared about did not come along, and nothing in the product explained that.

## Decision Drivers

- A single-device user adopting a server expects their notes to become the server's content.
- Event identity and ordering must stay honest; transplanting events under rewritten ids would forfeit the property the event store exists for.
- The asset endpoints resolve their outline from the caller's credential, so an outline must exist before its assets can upload.
- Auto-merging two non-blank histories is explicitly out of scope (ADR-0012, "silent overwrite" mitigation).

## Considered Options

1. **Claim once, seed from the first device.** Bootstrap creates no outline; the first desktop to enroll claims the server and seeds it from its own replayed state. Later devices pull that outline and park their own.
2. **Re-seed on every connect.** Each connecting device overwrites server state. Destroys other devices' work and needs a destructive confirmation.
3. **Seed if blank, else merge.** Requires the merge semantics the conflict model refuses to provide.

## Decision

We will **bootstrap the server with an owner and credentials but no outline, and let the first desktop to enroll claim and seed it** because **a self-hosted server's first content should be the operator's existing notes, and seeding from a replayed document state achieves that without inventing merge semantics or rewriting event identity**.

Three scope decisions follow from it:

- **Claim once.** A unique index on `outlines(owner_id)` makes this a database invariant. A second device pulls the existing outline; its own local outline is parked, never merged.
- **Checkpoint genesis, not event replay.** The seed is the desktop's replayed final document state, written as the server's revision-0 checkpoint. Local event history stays local. Undo depth and pre-seed provenance remain single-device concerns.
- **Assets upload before the checkpoint.** Claiming is two phases — `POST /api/v1/outlines` then `PUT /api/v1/outlines/:id/seed` — because the asset endpoints key off `principal.outlineId`. Between them the outline is in state `seeding`, during which every sync, note-capture, and agent route returns `conflict`.

Claiming binds every credential the owner already holds, not only the claiming device; binding the claiming credential alone would strand the note-capture token permanently.

On the desktop, storage mode flips to server only after the seed succeeds, and the outbox is settled in the same transaction that writes the genesis checkpoint locally. Those pre-seed events are marked accepted with a null server revision, and the checkpoint is written at the highest local sequence it contains so replay does not apply them a second time.

## Consequences

### Positive

- A single-device user's notes become the server's content on connect.
- A blank server is discoverable only by attempting a claim, so an unauthenticated endpoint leaks nothing about whether the owner has data.
- Every failure mode before the outbox is settled leaves the device in local mode and is retryable.

### Negative

- Pre-seed local history never reaches other devices; device #2 sees the outline starting at revision 0 with no backstory.
- A device meeting an already-seeded server still parks its local outline. The wizard now says so explicitly, but the content is still only reachable by disconnecting.
- This feature does not rescue an already-seeded server. It changes what a freshly bootstrapped one does.
- Asset upload happens inside the native command, so the wizard reports the asset count up front rather than incremental per-asset progress.

### Risks and Mitigations

- **Duplicated content after seeding:** settle the outbox and write the genesis checkpoint in one SQLite transaction, at the highest local sequence the seed contains.
- **Seed referencing absent images:** the server verifies every referenced `assetId` is present and complete before accepting the checkpoint.
- **Partial claim:** re-claiming with the same credential and outline id is idempotent, as is an identical re-seed of a `seeding` outline.

## Validation

- PostgreSQL contract tests cover blank bootstrap, credential binding on claim, claim rejection, inbox derivation, incomplete-asset rejection, and re-seed idempotence.
- API tests cover HTTP claim and seed, and confirm sync, notes, and agent routes refuse a `seeding` outline.
- `cargo test` covers outbox settlement and genesis checkpoint atomicity, and that another outline's outbox is untouched.
- Desktop tests cover adoption ordering, the wizard without an Outline ID field, a failed copy leaving local mode intact, and the first sync after a seed pushing nothing.

## References

- [ADR-0012: Use an Event Store with an Optional Self-Hosted Server](ADR-0012-event-store-and-optional-server.md)
- [Design spec](../superpowers/specs/2026-09-12-blank-server-outline-adoption-design.md)
- [Server operation and Notes API](../server-backend.md)
