# Server-Mode Authority and Agent Execution Implementation Plan

- **Date:** 2026-09-13
- **Status:** Core implementation complete; exhaustive acceptance hardening remains
- **Specification:** [Server-Mode Authority and Agent Execution](../specs/2026-09-13-server-mode-authority-and-agent-execution-design.md)

## Objective

Implement the approved server-mode authority design without truncating the
existing development server or weakening local-first editing. The rollout must
first remove correctness dependencies on the stale note index, then separate
portable configuration from compute, simplify admission, and finally introduce
durable concurrent run management and atomic result placement.

## Implementation record (2026-09-13)

The core architecture in this plan is implemented end to end. The retained
development database was upgraded in place; it was not truncated. Startup
reconciliation rebuilt its incomplete note projection, and canonical admission
for the existing `/research` bullet now succeeds even when the disposable note
row is absent.

| Phase | Implemented result | Remaining acceptance evidence |
| --- | --- | --- |
| 1. Canonical query boundary | Shared canonical query API and typed live/missing/trashed results now serve admission, note validation, and result placement. | None for the core boundary. |
| 2. Disposable note index | Migration 0004, projector metadata, transactional batch rebuild, startup reconciliation, readiness, and corrupt-cache PostgreSQL coverage are in place. | Record a representative large-outline rebuild benchmark and exercise every historical migration snapshot. |
| 3. Portable configuration and compute | Portable configuration v2 excludes model and credentials; local/server compute profiles resolve lazily and legacy state upcasts without exposing secrets. | Expand credential-revocation and long-lived queued-run coverage. |
| 4. Configuration mirror | The desktop persists the confirmed base and implements unchanged, local-only, server-only, and explicit two-sided conflict reconciliation. | Add a process-restart conflict-dismissal acceptance test. |
| 5. Provisioning and readiness | Resumable connection/outline/sync/configuration/mirror/compute steps, sync-only operation, and the readiness vector are implemented; Run no longer repairs configuration. | Exercise interruption after every individual provisioning transition. |
| 6. Intent admission | Versioned invocation intents, canonical server-side resolution, stable idempotency, lazy compute, typed state errors, and legacy protocol compatibility are implemented. | Complete the exhaustive HTTP/UI error-presentation matrix. |
| 7. Global run manager | Run observation lives above the slash menu, persists remote run IDs/cursors, restores after restart, tolerates transient disconnects, and keeps concurrent runs independent. | Complete manual app-close/reopen and individual cancellation walkthroughs. |
| 8. Atomic results | Structured output is persisted before placement; `completed_unplaced`, exactly-once placement, and one `agent.result_committed` event are implemented. The desktop records that event as one persistent undo unit. | Complete the full target-mutation, lease-loss, ambiguous-response, and server-restart matrix. |
| 9. Offline reconciliation | Editing remains available during network synchronization; remembered server identity and run history survive disconnect; remote events use the existing safe rebase path. | Complete the many-run disconnect/reconnect manual matrix and explicit-conflict walkthrough. |
| 10. Compatibility and docs | Capabilities are advertised, the old Run path no longer performs lazy migration, architecture/backend/OpenSpec docs are updated, and ADR-0016 through ADR-0020 record the decisions. | Remove v1 full-`RunInput` compatibility only after supported older clients are retired. |

Automated evidence collected during implementation:

- focused desktop synchronization, session, persistent-history, and application
  tests: 74 passing;
- broader focused feature regression: 58 passing;
- PostgreSQL integration suite against a dedicated test database: 21 passing;
- Rust native persistence/transport tests: 29 passing;
- desktop production build, server typecheck, Rust `cargo check`, and workspace
  layout checks passing.

The repository-wide JavaScript suite still has 14 pre-existing editor structure
expectation failures in `outlineStructure`/collapse behavior. Those failures
reproduce outside this change and are not hidden by this status. The detailed
checkboxes below remain the acceptance backlog and traceability checklist; this
implementation record is the authoritative shipped-versus-pending summary.

## Delivery principles

- Preserve immutable outline events and canonical user content.
- Prefer forward migrations and idempotent backfills.
- Keep old and new wire behavior explicitly versioned during rollout.
- Land every behavior change with in-memory, PostgreSQL, protocol, desktop, and
  regression coverage appropriate to the boundary.
- Do not update `docs/architecture.md` to claim a phase is current until that
  phase is implemented and verified.
- Do not remove compatibility code until the replacement client and server
  behavior are both available.

## Phase 1: Establish the canonical node-query boundary

### Domain/server helpers

- [ ] Add a shared canonical-outline query module that parses an `OutlineState`
  once and can resolve a node, its text, parent, ancestors, system role, Trash
  membership, and live placement status by stable node ID.
- [ ] Define explicit results for live, missing, and trashed nodes rather than
  returning an ambiguous null.
- [ ] Add fixtures covering deeply nested bullets, moved nodes, Trash, duplicate
  defensive handling, empty paragraphs, generated image siblings, and system
  nodes.

### Replace correctness-critical lookups

- [ ] Change manual run admission context lookup to read
  `outline_projections.state` at `outlines.current_revision`.
- [ ] Change Notes API parent validation to use the canonical outline.
- [ ] Change agent result target validation and placement to use the canonical
  outline.
- [ ] Audit move/create/delete and automation admission paths for any remaining
  correctness dependency on `note_projections`.
- [ ] Keep `searchOutline` as the only initial consumer of the flattened note
  index.

### Regression gate

- [ ] Add an in-memory contract test in which the canonical source exists and
  the note cache does not; admission must succeed.
- [ ] Add the equivalent PostgreSQL integration test by deliberately removing a
  derived note row while retaining the canonical document.
- [ ] Assert that a genuinely missing or trashed canonical source returns the
  new typed state error rather than `authorization_denied`.
- [ ] Reproduce the current `/research` failure against the retained development
  database and verify admission no longer depends on its stale index row.

## Phase 2: Make the note index disposable and self-repairing

### Persistence

- [ ] Add forward migration `0004` with per-outline note-projector metadata:
  source outline revision, projector schema version, rebuild status, and update
  timestamp.
- [ ] Implement a deterministic full rebuild from
  `outline_projections.state`, replacing all rows for one outline and advancing
  metadata in one transaction.
- [ ] Rebuild once after an accepted event batch rather than once per event.
- [ ] Ensure seed/adoption initializes projector metadata consistently.

### Startup reconciliation

- [ ] Assign the current note-projector schema version in server code.
- [ ] During startup/migration, discover missing, outdated, or revision-lagging
  note indexes and rebuild them idempotently.
- [ ] Keep canonical outline APIs available according to migration safety;
  expose note-index readiness separately.
- [ ] Never mutate immutable events or require database truncation during this
  repair.

### Search behavior

- [ ] Return index revision/readiness with internal search results or validate
  readiness before querying.
- [ ] Choose and implement the initial rebuilding behavior: canonical fallback
  for small outlines or typed `projection_rebuilding` for search only.
- [ ] Canonically validate a selected move/search destination immediately before
  applying the operation.

### Verification

- [ ] Test clean install, upgrade with no metadata, upgrade with an older schema
  version, interrupted rebuild rollback, and a falsely current outline paired
  with missing note rows.
- [ ] Verify a second startup performs no unnecessary rebuild.
- [ ] Measure full rebuild time with a representative large personal outline
  and record the threshold that would justify incremental projection.

## Phase 3: Separate portable configuration from compute

### Shared contracts

- [ ] Remove `modelId` and `credentialRef` from portable agent definitions.
- [ ] Keep agents limited to instructions and tool policy; keep skills limited
  to workflow, assigned agent, and capability requirements.
- [ ] Add a versioned `ComputeProfile` contract containing provider, selected
  model ID, and an environment-local credential binding.
- [ ] Add sanitized compute-profile metadata schemas for UI/readiness responses;
  prohibit secret material in configuration and run-history payloads.
- [ ] Provide explicit upcasters from the current embedded model/credential
  configuration to the new portable configuration plus environment bindings.

### Local and server storage

- [ ] Add local compute-profile persistence using the existing SQLite credential
  metadata and vault boundaries.
- [ ] Add PostgreSQL server compute-profile revisions or compare-and-swap state
  with owner/outline binding.
- [ ] Migrate existing server agent credential references into the server
  compute profile without returning decrypted secrets.
- [ ] Preserve the current local model and credential selection as the local
  compute profile.

### Runtime resolution

- [ ] Make local admission resolve the local active compute profile lazily.
- [ ] Make server admission resolve the server active compute profile lazily.
- [ ] Snapshot the resolved model and sanitized credential metadata in each run.
- [ ] Ensure changing the selected model affects only subsequently admitted
  runs.
- [ ] Validate skill capability requirements against the resolved compute
  profile and executor tool registry.

### Verification

- [ ] Test configuration portability across environments with different
  credentials.
- [ ] Test that agent definitions remain byte-equivalent when the selected model
  changes.
- [ ] Test queued and running snapshots remain unchanged after Compute settings
  change.
- [ ] Test credential revocation blocks queued work without exposing secrets.

## Phase 4: Add configuration mirroring and reconciliation

### Local mirror

- [ ] Persist the last confirmed portable server configuration, revision, and
  canonical hash in SQLite.
- [ ] Track local disconnected edits relative to that recorded base.
- [ ] In connected mode, publish Settings changes first and update the local
  mirror only from the confirmed server response.
- [ ] Remove opportunistic whole-configuration publication from unrelated
  Settings initialization paths.

### Reconnect algorithm

- [ ] Implement the four-way unchanged/local-only/server-only/both-changed
  comparison from the specification.
- [ ] Pull server-only changes and publish local-only changes with
  compare-and-swap.
- [ ] Add a whole-configuration conflict surface with **Use local** and **Use
  server** actions.
- [ ] Prove that conflict dismissal or app restart changes neither side.

### Verification

- [ ] Add configuration-hash canonicalization tests.
- [ ] Add reconnect matrix tests for all four comparison outcomes.
- [ ] Add concurrent publication tests proving a stale base cannot overwrite a
  newer server revision.
- [ ] Verify deliberate disconnect activates the latest confirmed local mirror.

## Phase 5: Replace lazy repair with explicit provisioning and readiness

### Provisioning state machine

- [ ] Extend first connection to persist idempotent steps for connection pinning,
  outline claim/adoption, asset/outline seed, initial synchronization, portable
  configuration import/reconciliation, mirror persistence, and optional compute
  setup.
- [ ] Resume at the first incomplete step after failure or restart.
- [ ] Remove all configuration publication and credential migration from the
  manual Run path.
- [ ] Offer credential copy, direct server connection, or sync-only operation as
  explicit choices.

### Readiness API and UI

- [ ] Add a bound-device readiness endpoint returning independent state for
  connection, canonical outline sync, portable configuration, compute profile,
  worker, and note index.
- [ ] Include relevant revisions, compatibility versions, sanitized missing
  requirements, and recovery actions.
- [ ] Treat outline-sync readiness as sufficient for normal editing and
  synchronization.
- [ ] Gate server agent execution on configuration, compute, worker, protocol,
  and scope readiness without depending on note-index readiness.
- [ ] Surface readiness components in Connection/Compute settings instead of a
  single connected/error label.

### Verification

- [ ] Test interruption and retry after every provisioning step.
- [ ] Test an older outline-only connection upgrades through provisioning without
  requiring a run.
- [ ] Test sync-ready/compute-not-ready mode remains fully editable.
- [ ] Test pressing Run causes no configuration or credential write requests.

## Phase 6: Introduce intent-based admission and typed errors

### Protocol

- [ ] Add a versioned manual invocation-intent schema with `sourceNodeId`,
  `skillId`, bounded `prompt`, `acknowledgedOutlineRevision`, and stable
  `invocationId`.
- [ ] Remove client-supplied model, credential, effective-tool, definition, and
  context snapshots from the new admission request.
- [ ] Add a canonical intent hash and uniqueness independent of configuration
  revision.
- [ ] Advertise the new admission protocol in server status and retain or reject
  the old contract explicitly according to compatibility policy.

### Admission service

- [ ] Create one server application service that authenticates, checks the
  canonical revision, resolves canonical source/context, loads current portable
  configuration, resolves compute, validates capabilities, snapshots the run,
  and admits it durably.
- [ ] Derive the initial manual target from the stable source node.
- [ ] Return the existing run for an identical invocation retry.
- [ ] Return idempotency conflict when the same invocation ID carries different
  intent.
- [ ] Make **Run again** create a new invocation linked to the prior run.

### Error taxonomy

- [ ] Reserve `authorization_denied` for genuine scope denial.
- [ ] Add structured codes and recovery metadata for outline sync, missing or
  changed source, configuration readiness/conflict, compute readiness,
  unavailable capability, rebuilding projection, and unavailable worker.
- [ ] Preserve cross-owner hiding for public or improperly bound callers while
  returning precise state errors to the correctly bound owner device.
- [ ] Map typed errors to specific desktop actions rather than parsing message
  strings.

### Verification

- [ ] Test lost-response retry, concurrent identical admission, same ID with
  changed input, explicit rerun, and configuration changes between retries.
- [ ] Test every error code's HTTP status, retryability, recovery action, and UI
  presentation.
- [ ] Verify the original generic 403 is impossible for canonical source/cache
  divergence.

## Phase 7: Move observation into a global run manager

### Desktop architecture

- [ ] Add an application-level run manager shared by local and server executors.
- [ ] Move server polling/subscription ownership out of `SlashMenu`.
- [ ] Persist admitted run IDs and sanitized last-known activity locally.
- [ ] Resume observation for non-terminal runs after app restart or server
  reconnect.
- [ ] Keep the editor and slash popup independent of run lifetime.

### UI

- [ ] Present concurrent queued/running/completed-unplaced/failed/cancelled runs
  in one activity surface.
- [ ] Support individual cancellation, explicit rerun, and result navigation.
- [ ] When disconnecting with active server runs, state that they continue and
  will reconcile on reconnect; do not block editing or disconnect.
- [ ] Ensure multiple simultaneous runs do not overwrite each other's activity
  or invocation errors.

### Verification

- [ ] Test multiple concurrent runs, app closure, reopen, reconnect, individual
  cancellation, and independent activity cursors.
- [ ] Test that unmounting the slash menu never cancels or abandons observation
  of an admitted run.
- [ ] Test offline local editing while remembered server runs continue remotely.

## Phase 8: Persist output first and commit one atomic result event

### Durable output

- [ ] Add forward persistence for validated structured run output independent of
  placement state.
- [ ] Extend run status with `completed_unplaced` and store the reason placement
  was unavailable.
- [ ] Ensure retries after an ambiguous commit can recover the stored output and
  existing result identity.

### Domain event

- [ ] Define and version `agent.result_committed` with run identity, target node,
  bounded generated subtree, asset references, and sanitized provenance.
- [ ] Add reducer/upcaster/compatibility handling in shared domain and document
  packages.
- [ ] Apply the generated subtree atomically as one undoable outline change.
- [ ] Gate server emission on desktop protocol compatibility before rollout.

### Placement service

- [ ] Resolve the target stable ID from the latest canonical outline under the
  outline transaction lock.
- [ ] Place below a moved or text-edited live target.
- [ ] Mark output unplaced when the target is missing or in Trash; never
  resurrect it.
- [ ] Add an authenticated action to place an unplaced result at a user-selected
  live target exactly once.
- [ ] Order concurrent results through assigned server revisions without
  interleaving their generated subtrees.

### Verification

- [ ] Test moved target, edited target, deleted target, trashed target, restored
  target, concurrent results under one parent, cancellation race, lease loss,
  and ambiguous transaction response.
- [ ] Test a multi-level result is never observed partially and forms one undo
  unit on every client.
- [ ] Test placement failure preserves the complete structured output across
  server restart.

## Phase 9: Reconcile disconnect, offline editing, and remote results

- [ ] Retain enough non-secret server identity metadata after disconnect to
  explain and later rediscover remote runs without retaining an active mode.
- [ ] Allow local edits immediately before, during, and after disconnection.
- [ ] On reconnect, pull remote agent result events before rebasing pending local
  edits.
- [ ] Apply the existing safe rebase rules; enter explicit outline conflict when
  an edit cannot be transformed safely.
- [ ] Reconcile run history separately from outline event synchronization so a
  terminal run remains visible even if its output is unplaced.
- [ ] Test disconnect with zero, one, and many active runs; remote completion;
  local branch edits; reconnect; safe rebase; and explicit conflict.

## Phase 10: Compatibility, cleanup, and documentation

- [ ] Raise or advertise the minimum compatible client before emitting
  `agent.result_committed`.
- [ ] Remove the old full-`RunInput` server admission path after compatibility
  evidence shows no supported client depends on it.
- [ ] Remove `modelId`/`credentialRef` compatibility fields from new portable
  configuration after upcaster coverage is complete.
- [ ] Remove lazy configuration and credential migration helpers from the
  desktop Run path.
- [ ] Update `docs/architecture.md` with the implemented authority table,
  compute-profile boundary, global run manager, and result event.
- [ ] Update `docs/server-backend.md` to replace current lazy migration guidance
  with provisioning, readiness, recovery, and credential-consent behavior.
- [x] Record the approved authority, configuration, compute, admission,
  concurrency, and result decisions in ADR-0016 through ADR-0020.
- [ ] Update OpenSpec requirements and scenarios before archiving or superseding
  the existing server-agent executor change.

## Verification matrix

| Boundary | Required evidence |
| --- | --- |
| Canonical queries | Shared unit fixtures plus in-memory repository contracts |
| PostgreSQL authority | Integration tests with deliberately corrupted disposable cache |
| Projector recovery | Clean install and upgrades from every prior migration state |
| Configuration mirror | Reconnect matrix, CAS race, restart persistence |
| Compute profile | Migration, lazy resolution, credential isolation, secret-redaction tests |
| Provisioning | Failure/retry test at every state transition |
| Admission | Protocol, idempotency, typed-error, and authorization tests |
| Run manager | Component/application tests across unmount, restart, and reconnect |
| Result placement | Concurrency, target mutation, exactly-once, and undo tests |
| Offline reconciliation | Remote-result plus local-edit rebase and conflict tests |
| Native boundary | Rust transport/persistence tests for every new command and migration |
| Workspace | Typecheck, production build, focused suites, PostgreSQL suite, and Rust tests |

## Rollout order and gates

1. **Correctness gate:** complete Phases 1 and 2 before relying on the current
   development database. This removes the live 403 failure without truncation.
2. **State-model gate:** complete Phases 3 through 5 before deleting any lazy
   migration compatibility path.
3. **Protocol gate:** ship the new status capability and client support before
   making intent-based admission mandatory.
4. **Event gate:** every supported desktop must understand
   `agent.result_committed` before a server emits it.
5. **Cleanup gate:** update canonical architecture documentation and remove old
   paths only after clean-install, upgrade, reconnect, and concurrency evidence
   passes.

## Manual acceptance walkthrough

- [ ] Start from the retained server whose canonical outline contains the
  `/research` bullet while the old note index omits it; run the skill
  successfully without resetting PostgreSQL.
- [ ] Connect a desktop with existing portable configuration to a blank server;
  finish outline/config provisioning, explicitly choose compute setup, and
  verify Run performs no migration writes.
- [ ] Disconnect, edit configuration locally, independently edit server
  configuration, reconnect, and resolve the visible conflict without silent
  loss.
- [ ] Start several agents under the same branch, continue editing and moving
  bullets, close and reopen the app, and observe all runs resume correctly.
- [ ] Delete one active run's target and verify its final output appears as
  `completed_unplaced`, survives restart, and can be placed once elsewhere.
- [ ] Disconnect while agents run, continue local editing, reconnect after
  remote completion, and verify results plus local edits reconcile through the
  event stream.

## Completion definition

This plan is complete only when all specification invariants and acceptance
scenarios have automated evidence, the retained inconsistent development
database works without truncation, current documentation describes the shipped
behavior, and no ordinary Run path publishes configuration or transfers a
credential.
