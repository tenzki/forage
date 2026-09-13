# ADR-0016: Use the Canonical Outline for Correctness-Critical Server Operations

- **Status:** Accepted
- **Date:** 2026-09-13
- **Deciders:** Forage maintainers
- **Supersedes:** None
- **Superseded by:** None

## Context

ADR-0012 established the immutable event stream and the ProseMirror document as
the outline model. The server nevertheless maintains two current-looking
representations:

- `outline_projections.state`, the complete JSON `OutlineState` reduced from
  accepted events; and
- `note_projections`, flattened rows containing stable ID, parent ID, text, and
  deletion state.

The flattened rows were introduced to make text search and parent lookup easy.
They later became an implicit authority for Notes API parent validation, agent
admission context, and agent-result placement.

That authority is unsafe. A deployed development server reached the same
revision in `outlines` and `outline_projections`, and its canonical document
contained a `/research` bullet, while `note_projections` had no row for that
stable ID. Run admission trusted the flat table and rejected the valid source
as unavailable. The generic authorization error obscured the actual projection
drift.

## Decision Drivers

- Forage has one ProseMirror document and must not introduce authoritative
  per-bullet relational state.
- A stale performance index must not reject, authorize, or corrupt a write.
- Stable node identity and Trash membership exist in the canonical document.
- Persistent installations must recover derived data without deleting user
  content.
- Search should remain efficient enough to support move and link workflows.

## Considered Options

1. **Canonical outline with a disposable note index.** Validate writes from the
   canonical document and use flattened rows only for search.
2. **Two co-authoritative projections.** Strengthen transactional updates and
   require both representations to agree before every operation.
3. **Remove the flattened index.** Traverse the canonical JSON for search and
   every other operation.

## Decision

We will **use `outline_projections.state` at
`outlines.current_revision` for every correctness-critical server operation and
treat `note_projections` as a disposable search cache** because **this preserves
one document authority while retaining an optimization that can be safely
rebuilt**.

The canonical outline resolves:

- whether a stable node exists and is live;
- its current text, parent, and ancestor context;
- whether it is in Trash;
- whether it can receive a child or generated result; and
- where a moved target currently lives.

Creating a child, moving a node, admitting an agent, and placing an agent result
must use that canonical resolution. Search may return candidates from
`note_projections`, but the chosen candidate is validated canonically when the
operation executes.

The note index records the source outline revision and projector schema version
it represents. Rebuilding the complete index from the canonical outline is
deterministic and idempotent. Startup and forward data migrations rebuild
missing, older, or lagging indexes without changing immutable events or
canonical content.

## Consequences

### Positive

- Projection drift cannot deny or corrupt correctness-critical operations.
- The server architecture continues to honor the single-document decision in
  ADR-0012.
- Existing inconsistent databases can repair themselves without truncation.
- Search retains a relational index and can later adopt incremental projection
  without changing authority.

### Negative

- Correctness paths must parse or traverse the canonical ProseMirror JSON.
- The server needs a shared, well-tested canonical node-query boundary.
- Projector revision/version metadata and startup reconciliation add operational
  work.
- Search may be temporarily stale or unavailable while its disposable index is
  rebuilding.

### Risks and Mitigations

- **Canonical traversal becomes expensive for very large outlines.**

  **Mitigation:** Parse once per operation, measure representative outlines,
  and add non-authoritative accelerators only after profiling.
- **A new call site accidentally treats the note index as authoritative.**

  **Mitigation:** Confine index access to a search repository and cover all
  stable-node operations with shared contract tests.
- **Projector metadata claims freshness despite corrupt rows.**

  **Mitigation:** Version rebuild logic, test deliberately incomplete indexes,
  and allow an operator/startup integrity reconciliation to regenerate all
  rows.

## Option Analysis

### Canonical outline with a disposable note index

This keeps one authority, makes repair safe, and preserves fast search. It does
require explicit query helpers and projection lifecycle metadata.

### Two co-authoritative projections

Transactions reduce ordinary drift but cannot protect existing data from old
code, partial migrations, or projector bugs. Requiring agreement would turn a
cache defect into an outline outage.

### Remove the flattened index

This has the smallest consistency surface, but discards useful search indexing
before its performance is shown to be unnecessary. It remains a possible later
simplification.

## Implementation Notes

The first rollout changes admission and result-placement reads before changing
index maintenance. A forward migration then adds note-projector source revision
and schema version, followed by an idempotent backfill from every canonical
outline. Full rebuilding occurs once per accepted event batch initially.

`outline_projections.revision` must equal `outlines.current_revision` before a
row is used as the canonical current outline. A mismatch is an internal state
condition, not an authorization denial.

## Validation

- Admission succeeds when the canonical source exists and its flat note row is
  deliberately absent.
- Notes API and agent-result placement use canonical parent/target state.
- Missing and trashed canonical nodes produce typed state errors.
- Clean install, upgrade, interrupted rebuild, and repeated-startup projector
  tests pass.
- The retained inconsistent development database runs `/research` without a
  reset.

## References

- [ADR-0012: Use an Event Store with an Optional Self-Hosted Server](ADR-0012-event-store-and-optional-server.md)
- [Approved design specification](../superpowers/specs/2026-09-13-server-mode-authority-and-agent-execution-design.md)
- [Implementation plan](../superpowers/plans/2026-09-13-server-mode-authority-and-agent-execution.md)
