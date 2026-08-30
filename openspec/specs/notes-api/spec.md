# notes-api Specification

## Purpose
TBD - created by archiving change add-optional-server-backend. Update Purpose after archive.
## Requirements
### Requirement: Create a plain-text note
The server SHALL expose `POST /api/v1/notes` for an authenticated external application to create one plain-text note in the outline bound to its token.

#### Scenario: Create a note successfully
- **WHEN** a caller with `notes:create` submits valid text and a unique idempotency key
- **THEN** the server returns `201 Created` with the assigned note ID, resolved parent ID, event ID, server revision, text, and creation timestamp

#### Scenario: Reject unsupported content
- **WHEN** a caller submits raw ProseMirror JSON, HTML, an image, nested children, or another unsupported content format
- **THEN** the server rejects the request with a structured validation error and creates no event

### Requirement: Inbox default destination
The server SHALL add a created note to the configured API Inbox when `parentId` is omitted. A caller-supplied `parentId` SHALL refer to an existing writable note in the token's outline.

#### Scenario: Omit the parent
- **WHEN** a valid create-note request omits `parentId`
- **THEN** the server creates the note as a child of the configured API Inbox

#### Scenario: Supply a valid parent
- **WHEN** a valid create-note request supplies an existing writable parent note ID
- **THEN** the server creates the note under that parent

#### Scenario: Supply a missing or deleted parent
- **WHEN** a create-note request supplies a parent ID that is missing, deleted, or outside the bound outline
- **THEN** the server returns a conflict or authorization-safe error and does not silently redirect the note to Inbox

### Requirement: Idempotent note creation
Every create-note request SHALL include an `Idempotency-Key`. Idempotency SHALL be scoped to the authenticated token, and replaying the same key SHALL return the original result without creating another note.

#### Scenario: Retry after a lost response
- **WHEN** a caller retries the same valid request with the same token and idempotency key
- **THEN** the server returns the original note ID, event ID, and revision without appending another `note.created` event

#### Scenario: Reuse a key with different content
- **WHEN** a caller reuses an existing idempotency key with a materially different request
- **THEN** the server returns an idempotency conflict and leaves the original note unchanged

### Requirement: Scoped external API tokens
External note creation SHALL require a named, non-revoked token with the `notes:create` scope. The token SHALL be bound to an owner and, where configured, one outline.

#### Scenario: Use a minimally scoped token
- **WHEN** a valid token with only `notes:create` calls the create-note endpoint
- **THEN** the server permits note creation but does not grant synchronization or administrative access

#### Scenario: Use a missing or revoked token
- **WHEN** a request omits its token or presents an invalid, expired, or revoked token
- **THEN** the server rejects the request and creates no note or event

### Requirement: Server-generated note event
A successful create-note command SHALL cause the server to assign the note identity and append exactly one canonical `note.created` event within the same PostgreSQL transaction that updates the outline projection.

#### Scenario: Observe a created note on a desktop
- **WHEN** an external application creates a note and a synchronized desktop later pulls the assigned revision
- **THEN** applying the `note.created` event inserts the same stable note ID, text, provenance, and parent into the desktop outline

### Requirement: Bounded and validated request data
The endpoint SHALL apply documented limits to text, source metadata, timestamps, headers, and total request size. The server SHALL treat inline `#tags` as ordinary note text and SHALL not introduce a separate tag field in the initial API.

#### Scenario: Exceed a request bound
- **WHEN** a caller submits text or metadata beyond a documented limit
- **THEN** the server rejects the request before appending an event

#### Scenario: Preserve source provenance
- **WHEN** a valid request supplies bounded source application and external-reference metadata
- **THEN** the server retains that metadata as note provenance without requiring it to appear in visible note text

### Requirement: Stable API response and location
On successful first creation, the server SHALL return `201 Created`, a `Location` header for `/api/v1/notes/{id}`, and a versioned JSON response. The existence of the location SHALL NOT require the corresponding GET endpoint to be implemented in this change.

#### Scenario: Return creation metadata
- **WHEN** note creation commits successfully
- **THEN** the response identifies the created resource and the authoritative event revision needed by synchronized clients

