# server-synchronized-outlines Specification

## Purpose
TBD - created by archiving change add-optional-server-backend. Update Purpose after archive.
## Requirements
### Requirement: PostgreSQL authoritative event order
In server mode, the server SHALL store accepted outline events in PostgreSQL and assign a monotonically increasing, gap-free revision order per outline. Event acceptance and projection updates SHALL be atomic.

#### Scenario: Accept an event at the current revision
- **WHEN** an authenticated device submits a valid event whose base revision matches the outline's current revision
- **THEN** the server appends the event at the next revision, updates derived state, and commits both changes atomically

#### Scenario: Retry an accepted event
- **WHEN** a device resubmits an event ID already accepted for that outline
- **THEN** the server returns the original assigned revision without appending a duplicate event

### Requirement: Checkpoint bootstrap and paginated pull
The server SHALL provide a compatible verified checkpoint for initial bootstrap and SHALL provide ordered, paginated events after a requested revision.

#### Scenario: Bootstrap a new device
- **WHEN** an authenticated device has no local state
- **THEN** it downloads the newest compatible checkpoint and all retained events after that checkpoint revision

#### Scenario: Pull later events
- **WHEN** a device requests events after a known server revision
- **THEN** the server returns the next bounded page in ascending revision order and reports the current outline revision

### Requirement: Offline outbox synchronization
The desktop SHALL synchronize pending local events after connectivity returns without blocking offline reading or editing. The desktop SHALL expose synchronization status that distinguishes offline, connecting, syncing, up-to-date, conflict, authentication-required, upgrade-required, and server-unavailable states.

#### Scenario: Reconnect with pending events
- **WHEN** a server-mode desktop reconnects after creating events offline
- **THEN** it pulls missing server events, rebases pending local events as needed, pushes valid pending events, and reaches up-to-date only after every local event is acknowledged

#### Scenario: Authentication expires during synchronization
- **WHEN** the server rejects synchronization because the device credential is invalid or revoked
- **THEN** the desktop retains all local events and enters authentication-required instead of reporting a generic connectivity failure

### Requirement: Stale revision handling
The server SHALL reject a push based on a stale revision with a structured `rebase_required` response. The desktop SHALL preserve the pending local events while applying missing remote events and attempting a deterministic rebase.

#### Scenario: Rebase independent changes
- **WHEN** a pending local change and accepted remote changes affect independent note identities or safely transformable ProseMirror positions
- **THEN** the desktop creates durable rebased replacement events and retries without losing either intention

#### Scenario: Preserve an unresolvable conflict
- **WHEN** pending and accepted changes cannot be transformed while preserving both intentions
- **THEN** the desktop retains both materials, stops automatic push for the affected change, and enters an explicit conflict state

### Requirement: One-owner access model
The initial server SHALL bootstrap exactly one owner and SHALL support multiple authenticated desktop devices for that owner. The data model SHALL retain owner identifiers so future multi-user support does not require changing event ownership.

#### Scenario: Authenticate an owner device
- **WHEN** a desktop presents a valid, non-revoked device credential for the owner
- **THEN** the server allows synchronization with the credential's outline

#### Scenario: Reject cross-outline access
- **WHEN** a credential attempts to access an outline outside its binding
- **THEN** the server rejects the request without revealing the outline's contents or existence beyond an authorization error

### Requirement: Secure configurable server transport
The desktop SHALL send authenticated server-mode traffic through a narrow native transport restricted to the configured server origin. The transport SHALL require system-verified HTTPS except for loopback development, reject embedded URL credentials and cross-origin redirects, and enforce time and response-size bounds.

#### Scenario: Connect to a configured server
- **WHEN** the owner supplies a valid server base URL and device token
- **THEN** the desktop verifies status, supported versions, authenticated ownership, and server instance ID before enabling server mode

#### Scenario: Detect a changed server instance
- **WHEN** a previously configured URL reports a different server instance ID
- **THEN** the desktop blocks authenticated synchronization until the owner explicitly reconnects the new instance

#### Scenario: Reject an insecure remote URL
- **WHEN** the owner configures a non-loopback HTTP URL or a URL containing credentials, query parameters, or a fragment
- **THEN** the desktop rejects the configuration without sending the token

### Requirement: Secure credential storage and revocation
The desktop SHALL store device secrets in OS-backed or encrypted credential storage and SHALL keep only a credential reference in ordinary settings. The server SHALL store only token hashes and SHALL support named, expiring, and revocable credentials.

#### Scenario: Display a newly generated token
- **WHEN** the owner creates an API or device token
- **THEN** the server displays the secret once and persists only the token hash and metadata

#### Scenario: Revoke a credential
- **WHEN** the owner revokes a token
- **THEN** subsequent requests using that token are rejected while already stored outline events remain intact

### Requirement: Protocol and document compatibility negotiation
The server SHALL advertise its instance ID, supported API and event versions, current document schema version, and minimum client version. The desktop SHALL refuse unsafe writes when compatibility cannot be established.

#### Scenario: Client upgrade is required
- **WHEN** the server requires a newer client or document schema for writes
- **THEN** the desktop retains local state, stops synchronization writes, and enters upgrade-required with a clear explanation

#### Scenario: Unknown event version is received
- **WHEN** a client or server encounters an event version it cannot interpret
- **THEN** it rejects application of that event and does not advance its acknowledged revision

### Requirement: Schema epochs
Document-schema migration SHALL create a verified checkpoint, migrate the document, append a `document.schema_migrated` event, and start a new event epoch. Operational replay of the new epoch SHALL begin from its migration checkpoint.

#### Scenario: Upgrade an outline document schema
- **WHEN** the server upgrades an outline to a newer supported document schema
- **THEN** it preserves the old epoch, records the migration boundary, and serves a checkpoint compatible with new clients

