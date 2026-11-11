## Purpose

Give the desktop and its Node sidecars one definition of the messages they exchange, validated on both sides.

## ADDED Requirements

### Requirement: Shared message schemas
Sidecar commands, the run payload and sidecar events SHALL be defined once as schemas in a package that both the desktop and the sidecar import. The types each side uses SHALL be derived from those schemas. Neither side SHALL declare its own copy.

#### Scenario: Field added to the run payload
- **WHEN** a developer adds a required field to the run payload schema
- **THEN** both the encoder and the decoder fail to compile until they handle it

### Requirement: Reject invalid messages
A receiver SHALL validate every message against the schema and SHALL reject an invalid one with an error. A receiver SHALL NOT repair, truncate or substitute fields, including the run identifier.

#### Scenario: Payload with a malformed run identifier
- **WHEN** the sidecar receives a run payload whose run identifier is invalid
- **THEN** the run fails with an invalid-payload error and no replacement identifier is generated

#### Scenario: Unknown event from the sidecar
- **WHEN** the desktop receives an event that matches no schema
- **THEN** the event is dropped and reported to diagnostics

### Requirement: Validated settled result
The sidecar SHALL report a finished run with a result that passes the shared structured-result schema, using the same conversion the server uses. Persisted turn outcomes read during recovery SHALL be validated before use.

#### Scenario: Local run finishes
- **WHEN** a local run settles with an outline
- **THEN** the desktop receives a result that satisfies the structured-result schema with the shared limits

### Requirement: One sidecar transport
Every desktop client of a sidecar process SHALL use one transport that owns spawning, bounded line framing, request correlation, timeouts, abort and teardown. Line and buffer limits SHALL be the same for every client unless a client declares a different limit explicitly.

#### Scenario: Oversized line
- **WHEN** any sidecar writes a line beyond the transport's limit
- **THEN** the transport fails the pending requests of that process with the same error for every client

### Requirement: Declared sidecar dependencies
The sidecar package SHALL declare every module it imports.

#### Scenario: Isolated install
- **WHEN** the sidecar package is installed without hoisted root dependencies
- **THEN** it builds and its tests pass
