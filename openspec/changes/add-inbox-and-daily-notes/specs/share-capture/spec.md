## ADDED Requirements

### Requirement: Apple Shortcuts share-sheet workflow
Forage SHALL document an Apple Shortcut that can appear in the system share sheet, accept text or URLs, convert the supported input to bounded plain text, and submit it through the authenticated Notes API. The workflow SHALL NOT require a Forage-owned macOS share extension or the main desktop process to be running.

#### Scenario: Share selected text
- **WHEN** a user runs the configured Shortcut with non-empty selected text
- **THEN** the Shortcut submits that text as one Notes API request

#### Scenario: Share a web URL
- **WHEN** a user runs the configured Shortcut with a web URL
- **THEN** the Shortcut submits a plain-text representation that retains the URL

#### Scenario: Share unsupported content
- **WHEN** the Shortcut receives an attachment that it cannot convert to non-empty bounded text
- **THEN** it stops without claiming that Forage accepted the capture

### Requirement: Authenticated and idempotent submission
The Shortcut SHALL submit captures with a scoped `notes:create` bearer token, JSON request body, and non-empty `Idempotency-Key`. Forage SHALL validate the existing bounded Notes API contract and SHALL replay an identical retry without creating a duplicate note.

#### Scenario: Submit a capture
- **WHEN** the Shortcut posts valid bounded text with valid credentials and a new idempotency key
- **THEN** the server atomically creates one note and returns `201 Created`

#### Scenario: Retry after an uncertain response
- **WHEN** the Shortcut repeats the same body and idempotency key after a timeout or interrupted response
- **THEN** Forage returns the original result without creating a second note

#### Scenario: Reject changed key reuse
- **WHEN** a caller reuses an idempotency key with different input
- **THEN** Forage rejects the request and preserves the original note

#### Scenario: Reject invalid credentials or input
- **WHEN** the request lacks the required scope, contains empty or oversized text, or includes unsupported rich structure
- **THEN** Forage rejects it without modifying the outline

### Requirement: Canonical Inbox routing
When the Shortcut omits `parentId`, the Notes API SHALL resolve the canonical `inbox` role from the authoritative outline projection at insertion time. It SHALL NOT route by title, position, or a hard-coded node ID.

#### Scenario: Change surrounding outline order
- **WHEN** unrelated top-level content is moved around the canonical Inbox without changing its role
- **THEN** a later Shortcut capture is still created directly beneath that canonical Inbox

#### Scenario: Repair or transfer canonical identity
- **WHEN** repair or an accepted document event changes which node carries the canonical Inbox role
- **THEN** the next Shortcut capture resolves the current role holder rather than a cached ID

### Requirement: Ordinary Inbox processing and API provenance
A note created through the Shortcut SHALL be ordinary outline content beneath Inbox. Bounded `source` fields supplied by the Shortcut SHALL remain in the immutable `note.created` event, while the visible note text SHALL remain plain text.

#### Scenario: Process a Shortcut capture
- **WHEN** a user edits, nests, moves, links, or trashes the created Inbox child
- **THEN** it behaves like an ordinary note elsewhere in the outline

#### Scenario: Record Shortcut provenance
- **WHEN** the Shortcut includes `source.application` set to `Apple Shortcuts`
- **THEN** the accepted event retains that source independently from visible text

### Requirement: Server availability is explicit
The initial Apple Shortcuts workflow SHALL require a reachable Forage server and SHALL document that limitation. Local-only share capture and a Forage-owned operating-system extension are outside this change.

#### Scenario: Server unavailable
- **WHEN** the Shortcut cannot reach the configured server
- **THEN** the request does not create a local desktop note and the Shortcut reports its request failure
