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
- Accept initial share-sheet captures through an Apple Shortcut and the authenticated Notes API without requiring the main app to be running.
- Preserve all user-authored content during initialization, migration, and invariant repair.
- Keep the single ProseMirror document as the source of truth and preserve one coherent undo history.

**Non-Goals:**

- Separate workspaces, folders, notebooks, or one editor/document per special node.
- Automatic categorization, summarization, or movement of Inbox items.
- Templates, prompts, recurring tasks, calendar-event import, reminders, or automatic content carry-over for daily notes.
- Task scheduling, due dates, priorities, projects, saved task filters, or a separate task database.
- A Forage-owned macOS share extension, arbitrary files, images, rich capture editing, or background web fetching.
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

Titles are presentation, not identity. The application owns the visible titles of system containers and daily-note roots, may localize or reformat them without breaking links or capture routing, and rejects direct user title edits. An ordinary user node with the text “Inbox” is not claimed or modified.

This avoids a parallel registry that can drift from the document and avoids new block node classes that would complicate existing list commands.

### 2. Maintain explicit hierarchy and uniqueness invariants

Each outline has exactly one top-level `inbox` and one top-level `daily-notes` node. Every `daily-note` is a direct child of the canonical `daily-notes` container, and at most one has a given `dailyDate`.

The canonical Inbox and Daily Notes containers keep application-managed titles, roles, stable identities, and hierarchy while presentation state such as expansion remains user-controlled. They cannot be trashed, purged, moved, converted, duplicated, or replaced. Daily-note roots likewise keep their managed title, `dailyDate`, role, and direct-child relationship to Daily Notes; they cannot be renamed, moved, reparented, indented, converted, duplicated, or arbitrarily replaced. Transaction-level validation covers direct text, cut, and replacement paths in addition to command guards. Rejected direct deletion or title edits are silent no-ops. User content below protected nodes remains ordinary outline content and may be edited, moved elsewhere, or trashed, subject only to the stable empty-direct-child keyboard behavior described below.

A daily-note root has one intentional lifecycle exception: an explicit Move to Trash action moves its complete subtree into recoverable Trash. Restore validates the trashed page's date and resolves the current canonical Daily Notes container at invocation time. It restores the complete subtree beneath that container only when the date is valid and no live daily note already owns it; an invalid date, missing canonical container, or live date conflict rejects the restore without removing the Trash entry.

Application-managed creation, relabeling, and expansion transactions remain durable and synchronized but use distinct change groups outside user undo/redo history. Validated remote projection replacement carries an explicit trusted origin through the transaction guard and is accepted only when the editor reaches the projected document exactly.

Initialization and migration add missing nodes without modifying unrelated content. Repair selects a canonical node deterministically by document order and stable ID, preserves all descendants, demotes duplicate role holders to ordinary nodes, and moves any orphaned daily-note root under the canonical Daily Notes container. Repair is one atomic document change so undo and persistence never observe a half-repaired hierarchy.

### 3. Treat Inbox as a destination, not a separate state machine

Inbox entries are direct child list items inserted in capture order. Once imported, they use the same model and commands as other user notes. There is no separate read/unread or processed flag in this change; moving or deleting an entry is the user's processing action.

The Notes API used by Apple Shortcuts resolves the node carrying the canonical `inbox` role at insertion time. It does not store a hard-coded title, position, or installation-specific ID.

### 4. Open daily notes directly from local calendar dates

The built-in Daily Notes destination computes the operating system's current local calendar date at invocation, resolves a direct child whose `dailyDate` matches that `YYYY-MM-DD` date, creates it if missing, then zooms into it. The managed date title renders a compact calendar picker immediately after its text only while the active zoom path is within the canonical Daily Notes branch. A dated page visible from Home has no picker. Choosing another date resolves or creates that date and navigates directly to it. Repeated activation for the same date focuses the same node.

The persisted `dailyDate`, rather than the formatted title, defines identity. Existing daily notes do not change dates if the time zone later changes. A newly created page is inserted newest-first under Daily Notes and receives a user-facing date label formatted for the current locale. The date root is system-managed; navigation focuses its first ordinary child and creates one blank child only when the page has none, so journal input starts in editable content.

The application does not automatically create a page at midnight or on startup. A date page appears only when the user opens Daily Notes or chooses a date from an existing daily note's picker, preventing background empty-page accumulation.

Empty editable-child handling is deliberately stable at system boundaries. Backspace on an empty leaf direct child of a system parent deletes that child and selects the parent. Enter on the selected system parent creates and selects one ordinary child; pressing Enter again on that empty child is ignored so it is neither split nor lifted.

### 5. Make Inbox, Daily Notes, and Tasks permanent application-owned sidebar items

Inbox, Daily Notes, and Tasks are always-present items in the application-owned sidebar navigation and built-in command menu. They are not seeded defaults in, persisted with, or managed by the user-shortcuts collection. Users cannot remove, rename, or reorder these items through shortcut controls. Inbox zooms to the canonical Inbox node and focuses its first ordinary child, creating one blank child only when Inbox is empty. Daily Notes resolves and opens today's daily-note node with the same editable-child focus behavior, and the inline calendar picker switches to another date. Tasks opens the derived all-tasks view described below.

The items remain represented when the sidebar is collapsed according to the sidebar's normal collapsed presentation. Exactly the current built-in destination receives selected styling: Home only for the unzoomed outline, Inbox or Daily Notes when the zoom path belongs to that system branch, and secondary panels while they are open. Built-in node navigation resolves roles on every use so migration or repair cannot leave stale sidebar IDs. Search, backlinks, and internal links continue to use stable node IDs.

### 6. Derive Tasks from the live outline

Tasks is a virtual view, not a third system-role node. It derives its rows from every live `listItem` whose `bulletKind` is `todo`, at any nesting depth and under any branch, including Inbox and Daily Notes. Trashed nodes are excluded because they are outside the live outline. Both open and completed tasks are included because the item promises all tasks; the view groups open tasks before completed tasks and preserves outline order within each group. Its sidebar badge displays only the open-task count and updates from the same live projection.

Each row retains the source task's stable node ID and current completion state. Opening a row navigates to or zooms into the original task in context. Toggling completion from the Tasks view dispatches the same command against the original node, so undo, persistence, synchronization, backlinks, and agent context continue to see one source of truth. Creating, converting, completing, reopening, moving, or trashing a task updates the view without persisting a copied task collection.

An ordinary user node titled “Tasks” remains ordinary content and is not claimed as the Tasks view.

### 7. Start share capture with Apple Shortcuts and the Notes API

The initial share workflow is a user-created Apple Shortcut shown in the system share sheet. It accepts text and URLs, converts the input into bounded plain text, and uses “Get Contents of URL” to `POST /api/v1/notes` with a scoped `notes:create` bearer token and a unique idempotency key. The existing Notes API validates the request, resolves the canonical Inbox role at insertion time, and commits the event and projection atomically.

This avoids an additional native extension target, app-group storage, Xcode project, signing identity, and queue protocol. It also means the initial workflow requires Forage's optional server mode and network access; local-only capture can be proposed later if there is a demonstrated need. The main desktop app need not be running, but the configured server must be reachable.

Each accepted request creates one direct Inbox child containing the Shortcut's plain-text representation. A Shortcut may combine a page title, URL, and selected text before posting. Empty, rich, nested, and oversized requests are rejected by the existing bounded Notes API contract. The mandatory idempotency key makes retries safe.

### 8. Keep API provenance in the event contract

Notes API requests may include bounded string provenance in `source`; the immutable `note.created` event retains it independently of visible text. The created outline item remains ordinary user content and can be processed like any other Inbox child.

### 9. Coordinate schema migration with the storage replatform

Against the current JSON persistence, this change increments the outline envelope/document schema and migrates existing files in memory before saving. If `add-optional-server-backend` lands first, the equivalent system-role initialization and repair occur through versioned document events and checkpoints instead. There must be only one active migration path in the final implementation; the behavioral requirements are the same in either storage mode.

## Risks / Trade-offs

- **[Risk] Protected nodes may conflict with generic editor commands.** → Centralize role guards in shared structural command validation and test keyboard, drag, paste, trash, and undo paths.
- **[Risk] A Shortcut may retry after a timeout without knowing whether the server committed.** → Require a stable per-run idempotency key and let the Notes API replay identical requests.
- **[Risk] Calendar identity can be surprising around midnight or time-zone changes.** → Resolve the current date whenever Daily Notes is invoked and never rewrite the `dailyDate` of an existing node.
- **[Risk] A task aggregate can drift from the editable outline.** → Derive it from the current document and target every action by the source node's stable ID instead of persisting task copies.
- **[Risk] Repairing duplicate or malformed role metadata could hide content.** → Never delete duplicate nodes or descendants; demote or reparent them in a single validated transaction.
- **[Trade-off] Apple Shortcuts capture requires server mode.** → Accept this for the initial workflow and defer a local-only bridge until demand justifies another native integration.
- **[Trade-off] Fixed system roots reduce structural freedom.** → Keep the two canonical containers permanent and the dated roots structurally managed, while allowing explicit dated-page trash and keeping captured and journal content beneath them ordinary and movable.
- **[Trade-off] Lazy daily pages do not produce a complete calendar history.** → Avoid empty branches now; calendar browsing and automatic page creation can be proposed separately.

## Migration Plan

1. Extend and validate list-item metadata without changing current rendering.
2. Add deterministic system-node initialization and repair to fresh and loaded outlines.
3. Add command guards and permanent sidebar/command-menu navigation, then enable direct calendar-driven daily-note navigation and the derived Tasks view.
4. Document and test the Apple Shortcuts request against the canonical Inbox Notes API.
5. Exercise migration against representative existing outlines and server-backed Shortcut flows before release.

Rollback removes the permanent navigation but must not strip role attributes or delete system branches; any schema downgrade must be refused if it would lose content.

## Open Questions

- Should a later change allow users to customize daily-note title formatting or seed new daily notes from a template?
- Should a later local-only capture proposal use a URL scheme, App Intent, or another native boundary?
