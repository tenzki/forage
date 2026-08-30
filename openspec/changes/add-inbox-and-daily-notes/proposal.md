## Why

Forage has one undifferentiated outline, so integrations do not have a stable place to deliver captured notes and users must manually create and find a page for each day. Canonical Inbox and Daily Notes nodes provide predictable capture and journaling entry points without introducing folders or a second document model.

## What Changes

- Add one canonical Inbox and one canonical Daily Notes container to every outline, identified by persisted role metadata rather than their visible titles or positions.
- Protect system nodes from deletion, title edits, and operations that would break their identity or required hierarchy while keeping notes beneath them ordinary, movable outline nodes.
- Add permanent application-owned sidebar items for Inbox, Daily Notes, and Tasks. They are always present, are never stored or managed as user-created shortcuts, and Tasks shows a live count of its open rows.
- Make Tasks a derived view of every live task in the outline, including nested and completed tasks, without creating a duplicate Tasks branch.
- Open the current local daily note directly in the outline and render a compact calendar picker after its managed date title (for example, “August 30, 2026 [calendar]”) so changing the date resolves or creates that day and focuses editable child content.
- Document an initial Apple Shortcut that receives share-sheet text or URLs and posts plain text to the authenticated Notes API, which inserts beneath the canonical Inbox.
- Repair missing or duplicate system-role metadata without discarding user content, and initialize the system nodes in existing outlines.
- Supersede the earlier planning decision that listed daily notes as out of scope.

## Capabilities

### New Capabilities

- `system-outline-nodes`: Permanent system navigation, canonical system-node identity, lifecycle protection, Inbox behavior, date-based Daily Notes behavior, and the derived all-tasks view.
- `share-capture`: Idempotent Apple Shortcuts capture through the authenticated Notes API into Inbox.

### Modified Capabilities

None. This repository has no archived OpenSpec capability specifications. The parallel `add-optional-server-backend` change may use this change's canonical Inbox as the default destination for its notes API.

## Impact

- The persisted outline schema gains explicit system-role and daily-date metadata and requires a versioned migration.
- Empty-document normalization and outline loading must establish and validate system-node invariants.
- Structural editor commands, drag/drop, trash, todo conversion, and paste normalization must respect protected nodes.
- The sidebar gains non-user-removable Inbox, Daily Notes, and Tasks destinations.
- The optional server's existing Notes API becomes the initial share-capture boundary; the desktop bundle gains no native share extension.
- Tests must cover migration, invariant repair, calendar boundaries, Shortcut request idempotency, and normal editing under both system containers.
