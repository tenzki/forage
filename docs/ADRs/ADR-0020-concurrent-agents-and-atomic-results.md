# ADR-0020: Keep Agent Runs Concurrent and Commit Results Atomically

- **Status:** Accepted
- **Date:** 2026-09-13
- **Deciders:** Forage maintainers
- **Supersedes:** None
- **Superseded by:** None

## Context

Agent execution may take much longer than an outline edit. A user must be able
to keep editing, start multiple agents, move or delete source branches, close
the app, or disconnect while server work continues.

The initial desktop server path observes a run from the slash-command component.
The initial server result path materializes a structured result as multiple
parent-first note events and fails the run when the target disappears. These
choices tie durable work to ephemeral UI, can expose partial generated trees,
and risk losing useful completed output because placement became impossible.

ADR-0006 requires explicit branch-local context, but that context can be
captured immutably at admission. It does not require locking the branch for the
duration of execution.

## Decision Drivers

- Outline editing must remain continuously available.
- Multiple agents must run concurrently, including under the same branch.
- Server work must survive popup closure, app closure, and disconnection.
- Moving a stable target should not invalidate useful work.
- Deleting or trashing a target must not resurrect content silently.
- Completed model output must not be lost because placement fails.
- A generated subtree should synchronize and undo as one coherent change.

## Considered Options

1. **Durable concurrent runs with persisted output and atomic placement.** Runs
   are server-owned; completed output is stored before one result event.
2. **Lock the source branch while a run executes.** Prevent target/context
   changes until completion.
3. **Keep UI-owned runs and multi-event insertion.** Continue polling in the
   slash menu and insert generated notes individually.

## Decision

We will **allow unrestricted editing and multiple concurrent agents, manage
runs durably outside the slash UI, persist completed output before placement,
and commit a placed result as one atomic domain event** because **long-running
work must coexist with local-first editing without losing or partially applying
results**.

The server owns admitted runs independently of any desktop process. The desktop
uses an application-level run manager that records run IDs, displays all run
states, resumes observation after reopening/reconnecting, and supports
individual cancellation and explicit retry. Unmounting the slash menu has no
effect on execution.

Closing or disconnecting does not cancel server work and does not block local
editing. The UI informs the user that remote runs continue and their statuses
and result events will reconcile on reconnect. Pending local edits continue in
the outbox and rebase over the authoritative remote event stream.

Validated structured output is persisted before placement. The latest
canonical outline resolves the stable target:

- a moved target receives the result at its current location;
- a live target whose text changed still receives the result, while the run
  retains its original context snapshot; and
- a missing or trashed target is not resurrected. The run becomes
  `completed_unplaced`, retains its complete output, and allows one later user-
  selected placement.

A successful placement emits one versioned `agent.result_committed` domain
event containing the run ID, target ID, bounded generated subtree, asset
references, and sanitized provenance. The server applies it in one outline
transaction at the latest revision. It is one synchronization unit, one undo
unit, and exactly one result placement.

Multiple results beneath the same live target are ordered by their accepted
server revisions. Their subtrees never interleave.

## Consequences

### Positive

- Agent latency never locks the editor or prevents another run.
- Runs remain observable across popup, application, and connection lifecycles.
- Completed output survives target deletion and server restart.
- Stable IDs give moved targets intuitive placement behavior.
- Results are never partially visible and undo coherently.
- Local edits and remote agent output use one existing synchronization model.

### Negative

- The desktop needs a global persistent run manager.
- The server needs durable structured output separate from placement metadata.
- `completed_unplaced` and a later placement action expand the run state machine
  and UI.
- A new compound domain event requires reducer, upcaster, protocol, and minimum-
  client compatibility work.
- Reconnecting after independent local and remote edits may still enter an
  explicit outline conflict when safe rebase is impossible.

### Risks and Mitigations

- **Two workers or retries place one result twice.**

  **Mitigation:** Lock the run/outline, enforce one result identity, and make
  placement idempotent.
- **A client observes a compound event it cannot reduce.**

  **Mitigation:** Advertise event support and gate server emission on the minimum
  compatible desktop version.
- **Large generated subtrees create oversized events.**

  **Mitigation:** Retain strict structured-result node, depth, text, and asset
  bounds before persistence and commit.
- **Remote results and local edits cannot rebase safely.**

  **Mitigation:** Preserve both sides and enter the existing explicit conflict
  state rather than overwriting either.
- **Users mistake disconnect for cancellation.**

  **Mitigation:** State clearly that active server runs continue and keep
  cancellation as a separate explicit action.

## Option Analysis

### Durable concurrent runs with atomic placement

This best matches local-first editing and server-owned background work. It adds
state-machine and compatibility complexity but preserves both user input and
model output.

### Lock the source branch

Locking simplifies placement but violates the requirement that the outline is
always editable and performs poorly with long or multiple runs.

### UI-owned runs with multi-event insertion

This is simpler initially but loses lifecycle observation on unmount/restart,
couples execution to presentation, and can expose partial results.

## Implementation Notes

The output store, `completed_unplaced` state, desktop reducer support, and
compound event ship together. Server status advertises
`agent.result_committed` version 1, and the desktop refuses an unknown
agent-origin event before advancing its acknowledged revision. The compound
event is the only outline materialization for a new server run.

Run activity remains a bounded operational stream separate from outline
events. Reconnection reconciles run history and outline events independently so
an unplaced terminal run remains visible despite having no outline event.

## Validation

- Multiple agents run while the user edits, moves, deletes, closes, reopens,
  disconnects, and reconnects.
- Slash-menu unmount never cancels or abandons an admitted run.
- Moved and text-edited targets receive results; missing/trashed targets retain
  durable unplaced output.
- Concurrent results beneath one parent have deterministic order and never
  interleave subtrees.
- Ambiguous commit retries and competing workers produce exactly one placement.
- Every supported desktop reduces and undoes the compound result as one change.
- Remote results and pending local edits rebase or enter explicit conflict
  without silent loss.

## References

- [ADR-0006: Generate Agent Output from Explicit Branch-Local Context](ADR-0006-branch-local-agent-generation.md)
- [ADR-0012: Use an Event Store with an Optional Self-Hosted Server](ADR-0012-event-store-and-optional-server.md)
- [ADR-0016: Use the Canonical Outline for Correctness-Critical Server Operations](ADR-0016-canonical-outline-over-note-index.md)
- [ADR-0019: Admit Server Agents From Invocation Intents](ADR-0019-intent-based-server-agent-admission.md)
- [Approved design specification](../superpowers/specs/2026-09-13-server-mode-authority-and-agent-execution-design.md)
- [Implementation plan](../superpowers/plans/2026-09-13-server-mode-authority-and-agent-execution.md)
