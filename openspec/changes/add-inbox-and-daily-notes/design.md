## Context

Forage stores the whole outline as one TipTap/ProseMirror document. Every note is a `listItem` with a stable `nodeId`; nesting, moving, zooming, search, links, trash, and undo all operate on that document. There is no folder layer or separate page database.

The product needs two stable destinations within that model:

- Inbox receives material captured from other applications and acts as a processing queue.
- Daily Notes contains one dated journal branch per local calendar day.

The sidebar also needs a permanent Tasks item that gathers task nodes from anywhere in the live outline. Unlike Inbox and Daily Notes, Tasks is a derived view rather than a persisted container.

The existing `nodeType` attribute records user-versus-agent provenance and must not be overloaded with navigation or lifecycle semantics. The optional-server proposal separately defines an API Inbox; when both changes are implemented, that API must resolve the same canonical Inbox role defined here.

## Goals / Non-Goals

**Goals:**

- Give every outline exactly one live Inbox and one live Daily Notes container.
- Keep an always-available Tasks view synchronized with task nodes throughout the live outline.
- Locate special nodes by durable semantic identity rather than title matching or document position.
- Make Inbox processing use normal outline operations: edit, nest, move, link, search, or trash captured child notes.
- Open or create exactly one daily-note branch for the user's current local date.
- Accept supported macOS share payloads without losing them when the main app is closed or interrupted.
- Preserve all user-authored content during initialization, migration, and invariant repair.
- Keep the single ProseMirror document as the source of truth and preserve one coherent undo history.

**Non-Goals:**

- Separate workspaces, folders, notebooks, or one editor/document per special node.
- Automatic categorization, summarization, or movement of Inbox items.
- Templates, prompts, recurring tasks, calendar-event import, reminders, or automatic content carry-over for daily notes.
- Task scheduling, due dates, priorities, projects, saved task filters, or a separate task database.
- Arbitrary files, images, rich share-extension editing, or background web fetching in the initial share target.
- Android, iOS, Windows, or Linux share integrations in the initial implementation.
- Changing the external notes API beyond making it resolve the same Inbox role when both proposals land.
- Retrofitting user-created nodes named “Inbox” or “Daily Notes” into system nodes based only on their text.

## Decisions

### 1. Represent special identity as list-item metadata

System nodes remain ordinary ProseMirror `listItem` nodes with the existing stable `nodeId`. A separate optional attribute records one of these roles:

- `inbox`
- `daily-notes`
- `daily-note`

A `daily-note` also carries a canonical `dailyDate` in `YYYY-MM-DD` form. `nodeType` continues to represent authorship only. Roles are serialized in the document, included in document/event schema validation, and preserved by copy-safe internal transforms.

Titles are presentation, not identity. System-managed labels may be localized or reformatted without breaking links or capture routing, and an ordinary user node with the text “Inbox” is not claimed or modified.

This avoids a parallel registry that can drift from the document and avoids new block node classes that would complicate existing list commands.

### 2. Maintain explicit hierarchy and uniqueness invariants

Each outline has exactly one top-level `inbox` and one top-level `daily-notes` node. Every `daily-note` is a direct child of the canonical `daily-notes` container, and at most one has a given `dailyDate`.

System containers and daily-note roots cannot be trashed, purged, indented, reparented, converted to todos, or overwritten by paste. User content below them remains ordinary outline content and may be edited, moved elsewhere, or trashed.

Initialization and migration add missing nodes without modifying unrelated content. Repair selects a canonical node deterministically by document order and stable ID, preserves all descendants, demotes duplicate role holders to ordinary nodes, and moves any orphaned daily-note root under the canonical Daily Notes container. Repair is one atomic document change so undo and persistence never observe a half-repaired hierarchy.

### 3. Treat Inbox as a destination, not a separate state machine

Inbox entries are direct child list items inserted in capture order. Once imported, they use the same model and commands as other user notes. There is no separate read/unread or processed flag in this change; moving or deleting an entry is the user's processing action.

Both local share capture and the proposed external notes API resolve the node carrying the canonical `inbox` role at insertion time. Neither stores a hard-coded title, position, or installation-specific ID.

### 4. Create daily notes lazily from local calendar dates

The built-in Daily Notes navigation action computes the date using the operating system's current local time zone at the moment of invocation. It resolves a direct child whose `dailyDate` matches that date, creates it if missing, then zooms into it. Repeated invocation on the same date focuses the same node.

The persisted `dailyDate`, rather than the formatted title, defines identity. Existing daily notes do not change dates if the time zone later changes. A newly created page is inserted newest-first under Daily Notes and receives a user-facing date label formatted for the current locale. The date root is system-managed; journal content is written as its descendants or attached note content.

The application does not automatically create a page at midnight or on startup. A date page appears only when Daily Notes is invoked, preventing empty-page accumulation.

### 5. Make Inbox, Daily Notes, and Tasks permanent application-owned sidebar items

Inbox, Daily Notes, and Tasks are always-present items in the application-owned sidebar navigation. They are not seeded defaults in, persisted with, or managed by the user-shortcuts collection. Users cannot remove, rename, or reorder these items through shortcut controls. Inbox zooms to the canonical Inbox node. Daily Notes resolves and zooms to today's daily-note node, while breadcrumbs still allow navigation to the Daily Notes container and the whole outline. Tasks opens the derived all-tasks view described below.

The items remain represented when the sidebar is collapsed according to the sidebar's normal collapsed presentation. Built-in node navigation resolves roles on every use so migration or repair cannot leave stale sidebar IDs. Search, backlinks, and internal links continue to use stable node IDs.

### 6. Derive Tasks from the live outline

Tasks is a virtual view, not a third system-role node. It derives its rows from every live `listItem` whose `bulletKind` is `todo`, at any nesting depth and under any branch, including Inbox and Daily Notes. Trashed nodes are excluded because they are outside the live outline. Both open and completed tasks are included because the item promises all tasks; the view groups open tasks before completed tasks and preserves outline order within each group.

Each row retains the source task's stable node ID and current completion state. Opening a row navigates to or zooms into the original task in context. Toggling completion from the Tasks view dispatches the same command against the original node, so undo, persistence, synchronization, backlinks, and agent context continue to see one source of truth. Creating, converting, completing, reopening, moving, or trashing a task updates the view without persisting a copied task collection.

An ordinary user node titled “Tasks” remains ordinary content and is not claimed as the Tasks view.

### 7. Use a durable macOS app-group queue for share capture

The initial share target accepts selected plain text, a web URL, or both. It assigns a capture ID, records the available source application, title, URL, capture timestamp, and text in a versioned bounded envelope, and atomically writes that envelope to an app-group queue shared with the main application. It reports success only after the envelope is durable.

The extension does not edit the ProseMirror document and does not require the main app to be running. The main app drains queued envelopes in creation order after it has loaded and repaired the outline. Importing an envelope and recording its capture ID are one logical persistence operation; an interrupted or repeated drain cannot create a duplicate Inbox entry. Successfully imported queue records may then be removed. Failed or unsupported captures remain visible as actionable errors and are not silently discarded.

Each accepted share creates one direct Inbox child. Shared text is retained as note content and a shared URL remains a clickable link; when both are present both are preserved. An empty payload and unsupported attachment-only payload are rejected. Initial bounds and supported uniform type identifiers are documented and enforced by both extension and importer.

### 8. Keep provenance separate from visible content

Imported notes carry optional structured provenance such as capture ID, source application, source URL, and capture time. Provenance must not be required to appear in the visible note text and must not change the note's `nodeType` from user-authored. Moving the note out of Inbox preserves its provenance.

The envelope schema and persisted provenance are versioned so future share formats can be added without guessing at old payloads.

### 9. Coordinate schema migration with the storage replatform

Against the current JSON persistence, this change increments the outline envelope/document schema and migrates existing files in memory before saving. If `add-optional-server-backend` lands first, the equivalent system-role initialization and repair occur through versioned document events and checkpoints instead. There must be only one active migration path in the final implementation; the behavioral requirements are the same in either storage mode.

## Risks / Trade-offs

- **[Risk] Protected nodes may conflict with generic editor commands.** → Centralize role guards in shared structural command validation and test keyboard, drag, paste, trash, and undo paths.
- **[Risk] Share-extension writes and app imports can be interrupted independently.** → Use atomic queue files, stable capture IDs, durable import receipts, and delete queue entries only after persistence succeeds.
- **[Risk] Calendar identity can be surprising around midnight or time-zone changes.** → Resolve the local date only when invoked and never rewrite the `dailyDate` of an existing node.
- **[Risk] A task aggregate can drift from the editable outline.** → Derive it from the current document and target every action by the source node's stable ID instead of persisting task copies.
- **[Risk] Repairing duplicate or malformed role metadata could hide content.** → Never delete duplicate nodes or descendants; demote or reparent them in a single validated transaction.
- **[Risk] A signed macOS share extension adds provisioning and release complexity.** → Keep the extension narrow, use one app group, document entitlement requirements, and include packaged-app smoke tests.
- **[Trade-off] Fixed system roots reduce structural freedom.** → Restrict only the three role-bearing node kinds; all captured and journal content beneath them remains ordinary and movable.
- **[Trade-off] Lazy daily pages do not produce a complete calendar history.** → Avoid empty branches now; calendar browsing and automatic page creation can be proposed separately.

## Migration Plan

1. Extend and validate list-item metadata without changing current rendering.
2. Add deterministic system-node initialization and repair to fresh and loaded outlines.
3. Add command guards and permanent sidebar navigation, then enable lazy daily-note creation and the derived Tasks view.
4. Add the versioned share envelope, durable import receipts, and importer behind a development-only queue adapter.
5. Add and sign the macOS share extension and app-group entitlement.
6. Exercise migration against representative existing outlines and package-level share flows before release.

Rollback removes the navigation and share extension but must not strip role/provenance attributes or delete system branches; older compatible builds should preserve unknown attributes, and any schema downgrade must be refused if it would lose content.

## Open Questions

- What exact text, URL, title, and total-envelope size limits should the initial share contract publish?
- Should a later change allow users to customize daily-note title formatting or seed new daily notes from a template?
- When server mode is implemented, should remote API captures expose the same provenance fields in the desktop UI as local macOS shares?
