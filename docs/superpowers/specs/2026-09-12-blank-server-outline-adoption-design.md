# Blank Server Outline Adoption

- **Date:** 2026-09-12
- **Status:** Approved design, not yet implemented
- **Related:** ADR-0012 (event store and optional server), `docs/server-backend.md`

## Problem

Today `bootstrapOwner` creates an outline with its own genesis content: an Inbox
node, a Daily Notes node, one empty bullet, a revision-0 projection, and a
genesis checkpoint (`apps/server/src/postgres.ts:62-118`). A desktop that has
been used in local mode therefore meets a server that already has a history.
The two streams cannot be reconciled, so connecting parks the local outline and
adopts the server's stub. The user's data does not come along, and there is no
import path.

The desired behavior is the reverse: a freshly bootstrapped server holds no
outline at all, and the first desktop to connect seeds it with that desktop's
local content.

## Decision

Bootstrap issues an owner and tokens only. The first desktop to enroll claims
the server, uploads its assets, and seeds the outline from its own replayed
local state. Later devices pull that outline and park their own local content,
exactly as they do today.

### Scope decisions

- **Claim once.** The first device to enroll seeds the server. Subsequent
  devices pull; their local outlines are parked, never merged.
- **Checkpoint genesis, not event replay.** The seed is the desktop's replayed
  final document state, written as the server's revision-0 checkpoint. Local
  event history stays local and is not replicated. Undo depth and per-event
  provenance from before the seed remain a single-device concern.
- **Assets upload before the checkpoint.** Every `assetId` referenced by the
  seeded document is uploaded and verified first; the seed is rejected if any
  is missing.

### Out of scope

Merging two non-blank histories; re-seeding an already-seeded server; uploading
local event history; multi-owner servers; the conflict merge editor (its own
spec).

## Server design

### The ordering constraint

`authorize()` resolves the principal's `outlineId` from the credential
(`apps/server/src/app.ts:344-348`), and the asset endpoints key off
`principal.outlineId` (`app.ts:284`, `app.ts:295`). Assets therefore cannot be
uploaded before an outline exists on the server, while the seed checkpoint
cannot be accepted before its assets exist. Claiming is consequently two
phases, not one upload.

### Bootstrap

`bootstrapOwner` stops creating the outline, note projections, revision-0
outline projection, and genesis checkpoint. It creates the owner and issues the
two tokens.

Migration `0003` makes `credentials.outline_id` nullable
(`apps/server/migrations/0001_server.sql:20`) and adds the outline `state`
column described below. An unclaimed token is owner-scoped; claiming binds it
to the outline it creates.

### Outline lifecycle

An `outlines` row gains a state: `seeding` on claim, `ready` after a successful
seed. `api_inbox_id` is null while `seeding`.

### New endpoints

**`POST /api/v1/outlines`** (scope `sync`) — body carries the desktop's local
outline id and outline name. Creates the `outlines` row in state `seeding` and
binds the caller's credential to it. Rejected when the owner already has an
outline, which enforces claim-once server-side rather than by convention. The
single exception is a retry: when the caller's own credential already owns a
`seeding` outline with the same id, the claim succeeds unchanged. A claim by a
second credential is rejected whether the existing outline is `seeding` or
`ready`.

**`PUT /api/v1/outlines/:outlineId/seed`** (scope `sync`) — body carries the
replayed document state. The server:

1. verifies every `assetId` referenced in the state is present and complete;
2. derives `api_inbox_id` from the `systemRole: 'inbox'` node in the state;
3. computes the integrity hash over the canonical JSON of the state;
4. writes the note projections, the `outline_projections` row at revision 0,
   and the genesis `outline_checkpoints` row;
5. flips the outline to `ready`.

Idempotent for an identical re-seed of a `seeding` outline. Rejected against a
`ready` outline.

### Behavior while `seeding`

`GET/POST /api/v1/outlines/:id/events`, `GET /api/v1/outlines/:id/checkpoint`,
`POST /api/v1/notes`, and the whole agent surface return a `conflict` error
stating the outline is not seeded.

`/api/v1/status` is unchanged. Whether a server is blank is discovered by
attempting a claim, not advertised: an unauthenticated endpoint must not leak
whether the owner has data.

## Desktop design

### The outbox problem

Local-mode events are written without a revision, which stores them as
`status: 'pending'` (`apps/desktop/src/persistence/eventStore.ts:73`). That is
the same outbox the sync engine drains on first sync
(`apps/desktop/src/sync/syncEngine.ts:155-161`). Seeding the server and then
letting sync start would push the entire local history on top of a checkpoint
that already contains it, duplicating every bullet. Adoption must settle the
outbox as part of the operation.

### Native commands

- **`server_enroll`** loses its `outline_id` parameter
  (`apps/desktop/src-tauri/src/sync_commands.rs:16-20`). It validates
  `/api/v1/status`, pins the instance, and stores the credential. The
  `GET .../checkpoint` probe at `sync_commands.rs:61-68` is removed: it exists
  to prove the outline is readable and is guaranteed to fail against a blank
  server. The command reads the local outline id from the existing identity
  (`apps/desktop/src-tauri/src/commands.rs:231-233`) and calls
  `POST /api/v1/outlines`.
- **`server_seed_outline`** (new) sends the replayed state to
  `PUT .../seed`.
- **`event_store_mark_seeded`** (new) performs, in one transaction: every
  pending event for the outline set to `accepted` with `server_revision = 0`,
  and a local checkpoint written at revision 0 holding the seeded state with
  the server's integrity hash. Local history stays on disk and undo continues
  to work; those events are simply no longer queued for push.

### Mode flip

`server_enroll` currently sets `StorageMode::Server` as its last act
(`sync_commands.rs:89`). This moves to after a successful seed. A seed that
fails halfway would otherwise leave the app in server mode pointed at an
outline stuck in `seeding` with a full local outbox. Until the seed succeeds
the app stays in local mode and the operation is retryable.

### Orchestration

Lives in TypeScript beside the sync engine, because it needs `loadReplayInput`
and `reduceOutlineEvent` to compute the state. Sequence:

1. replay local events to a document state;
2. walk the state for `assetId` references;
3. upload each through the existing `initiate`/`complete` asset path;
4. `PUT .../seed`;
5. `event_store_mark_seeded`;
6. set storage mode to Server;
7. prompt for restart.

### Wizard

`apps/desktop/src/components/Settings/ComputeSettings.tsx`:

- The **Outline ID** field is removed. The user supplies a server URL and a
  device token.
- A new step between Connect and Verify — *Copy this outline to the server* —
  shows asset upload progress (`n of m images`) and the node count being
  seeded. On failure it names the phase that broke and offers retry. Nothing
  local is mutated before `event_store_mark_seeded`.
- On a device connecting to an already-seeded server, the wizard states
  explicitly that the local outline will be left behind: "this device has a
  local outline with N nodes; connecting will switch to the server outline and
  leave it behind." This prevents a silent content swap on device #2.

### Sync engine

The bootstrap branch already handles "no local replay, adopt the server
checkpoint" (`syncEngine.ts:128-147`). After a seed, a local replay exists at
revision 0 matching the server, so the engine takes the normal pull path
unchanged. A device that never seeded hits the existing bootstrap branch
unchanged, which is claim-once falling out for free.

## Failure handling

| Fails at | Server state | Desktop state | Recovery |
|---|---|---|---|
| `POST /api/v1/outlines` | unchanged | local mode, credential stored | retry; re-claim by the same credential is idempotent |
| asset upload | `seeding`, some assets complete | local mode | retry; completed assets short-circuit (`app.ts:305-307`) |
| `PUT .../seed` | `seeding` | local mode | retry the seed; assets already uploaded |
| `event_store_mark_seeded` | `ready` | local mode, outbox still full | retry the native command alone |

The last row is the only state where server and desktop disagree, and is why
`event_store_mark_seeded` is a single transaction. The dangerous ordering would
be flipping storage mode before settling the outbox; the sequence above exists
to prevent it.

## Offline editing

Offline editing is unchanged. A device that has completed its first bootstrap
pull edits freely while disconnected; edits queue in the outbox and push on
reconnect. The only write gate is the one that already exists implicitly: a
device cannot edit an outline it has not yet obtained, whether by seeding or by
bootstrap pull.

Conflicts arising from concurrent offline editing are handled by the existing
rebase path (`syncEngine.ts:196-340`) and are unchanged by this work. The
absence of a conflict resolution UI is a known limitation, addressed in a
separate spec.

## Existing deployments

The migration makes `credentials.outline_id` nullable but does not retroactively
blank anything. An already-bootstrapped server keeps its outline and continues
to work. **This feature does not rescue an already-seeded server.** It changes
what a freshly bootstrapped one does. Getting local data onto an existing dev
server means resetting the database and re-bootstrapping.

## Testing

- `apps/server/src/postgres.test.ts` — `bootstrapOwner` creates no outline;
  claim binds the credential; a claim by a second credential is rejected; seed
  derives `api_inbox_id` from the inbox node; seed is rejected when a referenced
  asset is incomplete; re-seeding a `ready` outline is rejected; an identical
  re-seed of a `seeding` outline is idempotent.
- `apps/server/src/app.test.ts` — every sync, notes, and agent route returns
  `conflict` against a `seeding` outline.
- `cargo test` in `apps/desktop/src-tauri` — `event_store_mark_seeded` settles
  pending events and writes the revision-0 checkpoint atomically; a crash
  between the two leaves the outbox intact.
- `apps/desktop/src/sync/syncEngine.test.ts` — the first sync after a seed
  pushes nothing and pulls from revision 0.
- `apps/desktop/src/components/Settings/ComputeSettings.test.tsx` — the wizard
  has no Outline ID field; a failed seed leaves the app in local mode.

## Documentation

- `docs/server-backend.md`: the bootstrap section is rewritten. It currently
  instructs the reader to copy an outline ID that will no longer exist.
- A new ADR records this decision. It reverses ADR-0012's "No legacy iCloud or
  relational database migration is provided" for the local-to-server direction,
  which warrants its own record rather than an edit to ADR-0012.
