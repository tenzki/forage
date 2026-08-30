## Why

Forage has one undifferentiated outline, so integrations do not have a stable place to deliver captured notes and users must manually create and find a page for each day. Canonical Inbox and Daily Notes nodes provide predictable capture and journaling entry points without introducing folders or a second document model.

## What Changes

- Add one canonical Inbox and one canonical Daily Notes container to every outline, identified by persisted role metadata rather than their visible titles or positions.
- Protect system nodes from operations that would break their identity or required hierarchy while keeping notes beneath them ordinary, movable outline nodes.
- Add permanent application-owned sidebar items for Inbox, Daily Notes, and Tasks. They are always present and are never stored or managed as user-created shortcuts.
- Make Tasks a derived view of every live task in the outline, including nested and completed tasks, without creating a duplicate Tasks branch.
- Create at most one daily-note node for a local calendar date, lazily when the user opens Daily Notes for that date.
- Add an initial macOS share target that durably queues supported text and URL payloads and imports each capture as a child of Inbox, including when Forage is not running.
- Repair missing or duplicate system-role metadata without discarding user content, and initialize the system nodes in existing outlines.
- Supersede the earlier planning decision that listed daily notes as out of scope.

## Capabilities

### New Capabilities

- `system-outline-nodes`: Permanent system navigation, canonical system-node identity, lifecycle protection, Inbox behavior, date-based Daily Notes behavior, and the derived all-tasks view.
- `share-capture`: Durable, idempotent capture of supported content from the operating-system share UI into Inbox.

### Modified Capabilities

None. This repository has no archived OpenSpec capability specifications. The parallel `add-optional-server-backend` change may use this change's canonical Inbox as the default destination for its notes API.

## Impact

- The persisted outline schema gains explicit system-role and daily-date metadata and requires a versioned migration.
- Empty-document normalization and outline loading must establish and validate system-node invariants.
- Structural editor commands, drag/drop, trash, todo conversion, and paste normalization must respect protected nodes.
- The sidebar gains non-user-removable Inbox, Daily Notes, and Tasks destinations.
- The Tauri macOS bundle gains a share extension, app-group queue, entitlements, and a narrow import bridge.
- Capture provenance and deduplication metadata become part of persisted note data.
- Tests must cover migration, invariant repair, calendar boundaries, share-queue recovery, idempotency, and normal editing under both system containers.
