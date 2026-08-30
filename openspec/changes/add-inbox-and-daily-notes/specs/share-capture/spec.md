## ADDED Requirements

### Requirement: Accept supported macOS share payloads
The macOS share target SHALL accept a bounded payload containing plain text, a web URL, or both, with optional title and source-application metadata. It SHALL reject empty and unsupported attachment-only payloads without reporting a successful capture.

#### Scenario: Share selected text
- **WHEN** another application shares non-empty plain text to Forage
- **THEN** the share target accepts one capture containing that text

#### Scenario: Share a web URL
- **WHEN** another application shares a valid web URL with an optional title
- **THEN** the share target accepts one capture that preserves the URL and available title

#### Scenario: Share combined text and URL
- **WHEN** another application supplies both supported text and a URL in one share action
- **THEN** the share target preserves both values in one capture

#### Scenario: Share unsupported content
- **WHEN** a share action contains neither supported text nor a web URL, or exceeds a documented bound
- **THEN** the share target explains that it cannot accept the payload and does not enqueue a successful capture

### Requirement: Durable app-independent capture
The share target SHALL durably enqueue a versioned capture envelope in storage shared with the main application and SHALL NOT require the main Forage process or editor to be running. It SHALL report success only after the complete envelope is atomically durable.

#### Scenario: Share while Forage is closed
- **WHEN** a user completes a supported share while the main application is not running
- **THEN** the durable capture remains available for import the next time Forage opens

#### Scenario: Interrupt the queue write
- **WHEN** the share extension is interrupted before an envelope is atomically committed
- **THEN** the main application does not import a partial capture as a note

#### Scenario: Capture metadata
- **WHEN** a supported share is committed
- **THEN** its envelope includes a unique capture ID, schema version, capture timestamp, content, and any available bounded provenance

### Requirement: Inbox import
After loading the outline and restoring its system-node invariants, Forage SHALL import each valid queued capture as one ordinary direct child of the canonical Inbox. Shared text SHALL remain note content, a shared URL SHALL remain clickable, and capture provenance SHALL not be required to appear as visible text.

#### Scenario: Import a text capture
- **WHEN** Forage drains a queued text capture
- **THEN** it creates one ordinary Inbox child containing the shared text and retains the capture timestamp and available source metadata

#### Scenario: Import a URL capture
- **WHEN** Forage drains a queued URL capture
- **THEN** it creates one ordinary Inbox child from which the original URL remains accessible as a clickable link

#### Scenario: Move an imported note
- **WHEN** the user moves an imported note out of Inbox
- **THEN** the note behaves as ordinary outline content and retains its stable ID and capture provenance

### Requirement: Idempotent and ordered queue draining
Every capture SHALL have a stable capture ID. Forage SHALL import pending captures in creation order and SHALL durably record successful import before removing a queue entry so retries cannot create duplicate Inbox notes.

#### Scenario: Retry after persistence is interrupted
- **WHEN** queue draining resumes after interruption at any point in an earlier import attempt
- **THEN** each capture ID corresponds to at most one Inbox note and no uncommitted capture is silently discarded

#### Scenario: Receive duplicate delivery
- **WHEN** the queue contains more than one envelope with the same capture ID
- **THEN** Forage imports at most one note for that capture ID

#### Scenario: Drain multiple captures
- **WHEN** several valid captures are pending
- **THEN** their Inbox notes appear in capture order regardless of individual import retries

### Requirement: Recoverable capture failure
Forage SHALL retain enough information to retry a queued capture that cannot be decoded or persisted and SHALL surface an actionable error without exposing shared content in routine logs.

#### Scenario: Fail to persist an imported note
- **WHEN** importing a valid capture cannot be committed to the outline
- **THEN** the queue entry remains recoverable, no success receipt is recorded, and the user is informed that capture import is pending

#### Scenario: Encounter an unknown envelope version
- **WHEN** the importer encounters a capture envelope version it does not support
- **THEN** it leaves the envelope intact, does not create a partial note, and reports that a compatible Forage version is required

#### Scenario: Record diagnostics
- **WHEN** the extension or importer records routine diagnostic information
- **THEN** it may record capture IDs, versions, and states but does not record shared text, titles, URLs, or other payload content

### Requirement: Shared Inbox contract
All capture producers that target the default Inbox, including the macOS share target and the proposed external notes API, SHALL resolve the canonical `inbox` role at insertion time and SHALL NOT route by title, position, or a hard-coded node ID.

#### Scenario: Rename or reorder the Inbox presentation
- **WHEN** the canonical Inbox's presentation or top-level ordering changes without changing its role
- **THEN** subsequent captures continue to arrive beneath that same canonical node

#### Scenario: Repair the Inbox before import
- **WHEN** a queued capture is pending and outline loading repairs the canonical Inbox
- **THEN** import occurs only after repair and targets the repaired canonical Inbox
