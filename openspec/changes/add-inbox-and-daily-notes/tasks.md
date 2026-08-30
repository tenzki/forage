## 1. System-Node Schema and Invariants

- [ ] 1.1 Add runtime-validated `systemRole` and `dailyDate` list-item attributes without overloading authorship metadata
- [ ] 1.2 Increment the persisted schema and migrate existing outlines by adding canonical Inbox and Daily Notes roots without claiming title-matching user nodes
- [ ] 1.3 Implement deterministic invariant validation and content-preserving repair for missing, duplicate, nested, or orphaned role nodes
- [ ] 1.4 Update fresh-outline creation so required system roots and one ordinary editable location are present without a transient invalid document
- [ ] 1.5 Add fixtures covering fresh initialization, existing content, title collisions, duplicate roles, orphaned daily pages, unknown attributes, and idempotent repeated migration

## 2. Protected Editing Behavior

- [ ] 2.1 Centralize role-aware structural guards for indent, outdent, move, drag/drop, paste replacement, todo conversion, trash, restore, and purge
- [ ] 2.2 Keep descendants of Inbox and daily-note roots fully editable and movable using existing outline commands
- [ ] 2.3 Preserve system roles, daily dates, node IDs, and capture provenance across undo/redo, save/load, internal moves, and supported copy/paste paths
- [ ] 2.4 Add editor integration tests proving forbidden operations are no-ops with feedback and permitted descendant edits retain normal undo behavior

## 3. Permanent Sidebar Navigation and Tasks View

- [ ] 3.1 Add always-present, application-owned Inbox, Daily Notes, and Tasks sidebar items outside the persisted user-shortcuts collection
- [ ] 3.2 Ensure shortcut add, remove, rename, reorder, and clear operations cannot modify or hide the three permanent items
- [ ] 3.3 Resolve Inbox by role on every navigation and zoom to the canonical node
- [ ] 3.4 Implement local-calendar date resolution and idempotent lazy creation of one `daily-note` child per `YYYY-MM-DD` date
- [ ] 3.5 Insert daily-note roots newest-first, render their managed date labels using the current locale, and zoom to the resolved node
- [ ] 3.6 Derive the Tasks view from every live `todo` node at any depth, grouping open tasks before completed tasks while preserving outline order within each group
- [ ] 3.7 Add source-node navigation and completion toggling from Tasks without copying task content or creating a second task store
- [ ] 3.8 Keep Tasks current after create, convert, edit, complete, reopen, move, trash, restore, undo, redo, load, and synchronization changes
- [ ] 3.9 Add tests for permanent presence with zero or cleared shortcuts, collapsed-sidebar presentation, task aggregation and source actions, repeated same-day access, midnight rollover, daylight-saving transitions, time-zone changes, locale formatting, breadcrumbs, and undo-safe creation

## 4. Durable Share-Capture Contract

- [ ] 4.1 Define versioned, bounded share-envelope and persisted-provenance schemas for text, URL, title, source application, capture ID, and timestamp
- [ ] 4.2 Implement an atomic app-group queue adapter and durable capture-ID receipts with recovery from partial files and interrupted drains
- [ ] 4.3 Implement ordered, idempotent queue draining after outline load and invariant repair
- [ ] 4.4 Convert each supported envelope into one direct Inbox child while preserving shared text, a clickable URL, and structured provenance
- [ ] 4.5 Surface unsupported, invalid, or failed captures without deleting recoverable queue data
- [ ] 4.6 Add contract and integration tests for app-closed capture, retry, duplicate delivery, ordering, text-only, URL-only, combined content, empty payload, unsupported attachment, bounds, and persistence failure

## 5. macOS Share Extension and Packaging

- [ ] 5.1 Add the minimal macOS share extension for the documented text and URL uniform type identifiers
- [ ] 5.2 Configure matching app-group identifiers, sandbox entitlements, activation rules, signing, and release packaging for the app and extension
- [ ] 5.3 Keep the extension independent of the editor and write success responses only after atomic queue persistence
- [ ] 5.4 Add development diagnostics that redact shared content while reporting capture IDs and queue/import state
- [ ] 5.5 Verify the packaged app receives shares from representative macOS applications while running, backgrounded, and closed

## 6. Cross-Change Integration and Verification

- [ ] 6.1 Make the optional server notes API resolve the canonical Inbox role when that change is implemented, with no title- or position-based fallback
- [ ] 6.2 Document Inbox processing, Daily Notes date/time-zone semantics, share limits, unsupported payloads, permissions, and recovery behavior
- [ ] 6.3 Run unit, editor integration, persistence migration, packaged Tauri, and macOS share-extension tests
- [ ] 6.4 Validate both OpenSpec capability specifications and map every requirement scenario to automated or packaged-app test evidence
