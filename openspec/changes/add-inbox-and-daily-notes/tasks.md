## 1. System-Node Schema and Invariants

- [x] 1.1 Add runtime-validated `systemRole` and `dailyDate` list-item attributes without overloading authorship metadata
- [ ] 1.2 Increment the persisted schema and migrate existing outlines by adding canonical Inbox and Daily Notes roots without claiming title-matching user nodes
- [x] 1.3 Implement deterministic invariant validation and content-preserving repair for missing, duplicate, nested, or orphaned role nodes
- [x] 1.4 Update fresh-outline creation so required system roots and one ordinary editable location are present without a transient invalid document
- [x] 1.5 Add fixtures covering fresh initialization, existing content, title collisions, duplicate roles, orphaned daily pages, unknown attributes, and idempotent repeated migration

## 2. Protected Editing Behavior

- [ ] 2.1 Centralize role-aware structural guards that keep canonical containers permanent, keep dated-page title/date/hierarchy managed, authorize only explicit daily-note trash, and validate restore against the current canonical container and live dates
- [x] 2.2 Keep descendants of Inbox and daily-note roots editable and movable using existing outline commands, with stable Enter/Backspace handling for an empty leaf direct child
- [ ] 2.3 Preserve system roles, daily dates, and node IDs across undo/redo, save/load, internal moves, and supported copy/paste paths
- [ ] 2.4 Add editor integration tests proving forbidden operations are silent no-ops, explicit daily-note trash and validated restore preserve complete subtrees, and permitted descendant edits retain normal undo behavior
- [x] 2.5 Silently reject direct text, cut, delete, and replacement transactions against protected titles, keep descendants editable, and keep application-managed title/lifecycle changes outside user undo history

## 3. Permanent Sidebar Navigation and Tasks View

- [x] 3.1 Add always-present, application-owned Inbox, Daily Notes, and Tasks sidebar items outside the persisted user-shortcuts collection
- [x] 3.2 Ensure shortcut add, remove, rename, reorder, and clear operations cannot modify or hide the three permanent items
- [x] 3.3 Resolve Inbox by role on every navigation and zoom to the canonical node
- [x] 3.4 Implement local-calendar date resolution and idempotent lazy creation of one `daily-note` child per `YYYY-MM-DD` date
- [x] 3.5 Insert daily-note roots newest-first, render their managed date labels using the current locale, and zoom to the resolved node
- [x] 3.6 Derive the Tasks view from every live `todo` node at any depth, grouping open tasks before completed tasks while preserving outline order within each group
- [x] 3.7 Add source-node navigation and completion toggling from Tasks without copying task content or creating a second task store
- [x] 3.8 Keep Tasks current after create, convert, edit, complete, reopen, move, trash, restore, undo, redo, load, and synchronization changes
- [ ] 3.9 Add tests for permanent presence with zero or cleared shortcuts, collapsed-sidebar presentation, task aggregation and source actions, stable empty-child Enter/Backspace behavior, dated-page trash/restore conflicts, Daily Notes-only calendar visibility, repeated same-day access, midnight rollover, daylight-saving transitions, time-zone changes, locale formatting, breadcrumbs, and undo-safe creation
- [x] 3.10 Expand the destination and focus or create an ordinary editable child when opening Inbox or a selected Daily Note, and show the live open-task count (including zero) in the sidebar
- [x] 3.11 Add Inbox, Daily Notes, and Tasks to the command menu; derive the selected sidebar destination from the live view/zoom path; open today's Daily Note directly; and add an inline calendar-icon picker after its title for changing dates

## 4. Apple Shortcuts Capture

- [x] 4.1 Document a share-sheet Shortcut that accepts text and URLs, converts them to bounded plain text, and posts one JSON request to `/api/v1/notes`
- [x] 4.2 Require a scoped `notes:create` bearer token and per-run idempotency key so identical retries cannot duplicate notes
- [x] 4.3 Resolve the canonical Inbox role for every default Shortcut capture with no title-, position-, or cached-ID fallback
- [x] 4.4 Cover successful submission, identical retry, changed key reuse, invalid credentials, empty/rich/oversized input, and canonical-role changes in server integration tests
- [x] 4.5 Document that the initial Shortcut requires reachable server mode and that unsupported input or request failure does not create a local-only capture

## 5. Cross-Change Integration and Verification

- [x] 5.1 Make the optional server notes API resolve the canonical Inbox role when that change is implemented, with no title- or position-based fallback
- [x] 5.2 Document Inbox processing, Daily Notes date/time-zone semantics, Apple Shortcut setup, permissions, authentication, idempotency, and server-availability behavior
- [x] 5.3 Run unit, editor integration, persistence migration, server capture, and build tests
- [ ] 5.4 Validate both OpenSpec capability specifications and map every requirement scenario to automated or documented manual evidence
