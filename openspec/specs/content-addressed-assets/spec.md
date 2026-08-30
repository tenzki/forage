# content-addressed-assets Specification

## Purpose
TBD - created by archiving change add-optional-server-backend. Update Purpose after archive.
## Requirements
### Requirement: Content-addressed image identity
The system SHALL identify generated-image assets by the SHA-256 hash of their verified bytes. ProseMirror documents, events, and checkpoints SHALL store an asset identifier and alt text instead of base64 image data, temporary URLs, or local filesystem paths.

#### Scenario: Persist a generated image reference
- **WHEN** a verified generated image is inserted into the outline
- **THEN** the document node stores the stable content-derived asset ID and bounded alt text without embedding the image bytes

#### Scenario: Deduplicate identical bytes
- **WHEN** the same owner stores byte-identical image content more than once
- **THEN** the storage layer reuses the existing content-addressed asset rather than writing duplicate bytes

### Requirement: Verified image ingestion
The asset store SHALL accept only PNG, JPEG, and WebP images no larger than five megabytes. It SHALL verify declared media type, byte signature, decoded size, and SHA-256 hash before marking an upload complete and SHALL reject SVG.

#### Scenario: Complete a valid image upload
- **WHEN** an authenticated client uploads a bounded supported raster image whose bytes match the declared hash
- **THEN** the server marks the asset complete and makes it eligible for reference by outline events

#### Scenario: Reject invalid or mismatched content
- **WHEN** uploaded bytes are oversized, use an unsupported format, have an invalid signature, or do not match the declared hash
- **THEN** the asset store rejects the upload and no accepted outline event may reference it

### Requirement: Atomic asset reference validation
The server SHALL accept an event that references an asset only when that asset is complete and accessible to the event owner. Event acceptance SHALL NOT leave a committed reference to a missing or unauthorized asset.

#### Scenario: Reference an available asset
- **WHEN** an authenticated event references a complete asset owned by the outline owner
- **THEN** the server accepts the reference in the same transaction as the event and projection update

#### Scenario: Reference a missing asset
- **WHEN** an event references an unknown, incomplete, or unauthorized asset ID
- **THEN** the server rejects the event without advancing the outline revision

### Requirement: Local asset cache and offline rendering
The desktop SHALL cache referenced asset bytes in application data and SHALL resolve asset IDs to local renderable URLs without persisting those URLs in outline state.

#### Scenario: Render a cached asset offline
- **WHEN** a server-mode desktop is offline and has cached the bytes for a referenced asset
- **THEN** it renders the image from the local cache without contacting the server

#### Scenario: Encounter an uncached asset offline
- **WHEN** a server-mode desktop is offline and lacks a referenced asset's bytes
- **THEN** it preserves the asset reference and displays a recoverable unavailable state rather than deleting or rewriting the node

### Requirement: Pluggable server byte storage
The server SHALL store asset metadata and ownership in PostgreSQL while storing bytes through an asset-storage interface. The initial implementation SHALL support a server-managed filesystem and SHALL NOT require S3-compatible storage.

#### Scenario: Store bytes on the server filesystem
- **WHEN** the self-hosted server uses its initial filesystem asset backend
- **THEN** verified bytes are stored under a deterministic storage key while PostgreSQL retains their metadata and ownership

### Requirement: Conservative asset retention
The system SHALL NOT garbage-collect an asset while any retained live note, trash entry, event, or checkpoint can reference it. Permanent-erasure and backup-expiration behavior are outside this change.

#### Scenario: Delete a note containing an asset
- **WHEN** a note referencing an asset is moved to trash or deleted from the live projection
- **THEN** the asset remains available while retained history, trash, or checkpoints still reference it

### Requirement: Text-only external note API
The initial `POST /api/v1/notes` endpoint SHALL NOT accept asset uploads or asset references.

#### Scenario: External caller submits an image
- **WHEN** an external caller includes image bytes or an asset ID in a create-note request
- **THEN** the server rejects the unsupported field and creates no note

