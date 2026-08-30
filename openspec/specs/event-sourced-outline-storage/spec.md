# event-sourced-outline-storage Specification

## Purpose
TBD - created by archiving change add-optional-server-backend. Update Purpose after archive.
## Requirements
### Requirement: Explicit storage modes
The desktop SHALL provide mutually exclusive `local` and `server` storage modes. Local mode SHALL use local SQLite as the authoritative store and SHALL be documented as single-device. Server mode SHALL use local SQLite as a durable cache and outbox while treating the configured server as authoritative.

#### Scenario: Work in local mode
- **WHEN** the owner selects local mode and edits the outline
- **THEN** the desktop persists the resulting events to local SQLite without contacting a synchronization server

#### Scenario: Work in server mode while offline
- **WHEN** the owner edits a previously synchronized outline while the configured server is unavailable
- **THEN** the desktop persists the events locally, updates the local projection, and marks them pending synchronization

### Requirement: Durable event capture
The desktop SHALL represent every persisted outline change as one or more immutable, versioned events and SHALL make the local event durable before reporting the change as saved. Network batching SHALL NOT delay local durability.

#### Scenario: Persist a document-changing transaction
- **WHEN** a ProseMirror dispatch changes the document and includes appended normalization transactions
- **THEN** the desktop stores the complete step batch and its inverse steps atomically as a `document.steps_applied` event

#### Scenario: Ignore an ephemeral editor transaction
- **WHEN** a ProseMirror transaction changes only selection or other non-persisted UI state
- **THEN** the desktop does not append an outline event

#### Scenario: Persist non-editor state changes
- **WHEN** the owner trashes or restores a branch, changes a shortcut, accepts agent output, undoes, or redoes a persisted change
- **THEN** the desktop appends the corresponding event before reporting the operation as saved

### Requirement: Deterministic projection and replay
The system SHALL derive outline state through a deterministic event application function shared by desktop and server code. Applying the same compatible checkpoint and ordered events SHALL produce the same document, trash, shortcuts, and asset references.

#### Scenario: Rebuild after restart
- **WHEN** the desktop starts with a verified checkpoint and later local events
- **THEN** it loads the checkpoint, replays the later events in order, and produces the previously saved outline state

#### Scenario: Detect projection divergence
- **WHEN** replay produces a projection hash different from the stored verified hash at the same revision
- **THEN** the system enters a recovery error state and does not overwrite the conflicting data

### Requirement: Verified checkpoints
The local store SHALL create versioned checkpoints associated with the last included local sequence and optional server revision. A checkpoint SHALL include an integrity hash and SHALL be used only as a replay accelerator.

#### Scenario: Start from the newest compatible checkpoint
- **WHEN** multiple valid checkpoints exist at startup
- **THEN** the desktop selects the newest checkpoint compatible with its document schema and replays only later events

#### Scenario: Reject a corrupted checkpoint
- **WHEN** a checkpoint's calculated integrity hash does not match its stored hash
- **THEN** the desktop rejects that checkpoint and attempts recovery from an earlier valid checkpoint and retained events

### Requirement: Persistent undo and redo events
Undo and redo SHALL append compensating events rather than removing or mutating accepted history. The local store SHALL retain sufficient inverse-step and grouping information for supported undo operations to survive application restart.

#### Scenario: Undo a typing group
- **WHEN** the owner invokes undo after several consecutive typing events in the same change group
- **THEN** the desktop applies the stored inverse steps for the group and appends a new event with undo origin

#### Scenario: Preserve original history after undo
- **WHEN** an accepted change is undone
- **THEN** both the original event and the compensating undo event remain in the event history

### Requirement: Crash-safe local outbox
The local SQLite store SHALL atomically track local event order, synchronization status, checkpoint metadata, and server acknowledgements. A process crash SHALL NOT cause a confirmed local change or unacknowledged event to disappear.

#### Scenario: Recover an unsent event
- **WHEN** the application terminates after an event is stored but before the server acknowledges it
- **THEN** the next startup restores the projected change and retains the event in the pending outbox

#### Scenario: Record a server acknowledgement
- **WHEN** the server assigns revisions to a pushed event batch
- **THEN** the desktop records all acknowledgement mappings and synchronization state in one SQLite transaction

### Requirement: No active iCloud persistence
The desktop SHALL NOT use iCloud Drive as an authoritative outline store or synchronization transport. The active local database and asset cache SHALL reside in application data.

#### Scenario: Run without iCloud Drive
- **WHEN** iCloud Drive is unavailable or disabled
- **THEN** local and server storage modes continue to load and persist their local state normally

