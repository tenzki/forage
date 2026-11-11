## Purpose

Make failures that cross a process boundary machine-readable, so no caller decides what to do by reading error prose.

## ADDED Requirements

### Requirement: Coded native command errors
Every Tauri command SHALL fail with a serialized error that has a stable `code` and a human-readable `message`. Typed store, asset and transport errors SHALL map to codes in one place. The frontend SHALL branch on `code` and SHALL NOT inspect `message`.

#### Scenario: Missing stored credential
- **WHEN** a command fails because a stored credential is absent
- **THEN** the frontend receives the missing-credential code and treats the credential as absent

#### Scenario: Message wording changes
- **WHEN** a developer rewords an error message
- **THEN** no frontend behavior changes and no test fails

### Requirement: Server conditions pass through as codes
When a native command relays a server error, it SHALL preserve the server's error code as structured data. Authentication-required and upgrade-required SHALL be distinguishable from any other failure whose message happens to contain those words.

#### Scenario: Server reports authentication required
- **WHEN** the server rejects a sync request as unauthenticated
- **THEN** the sync engine enters the authentication-required state from the code alone

### Requirement: One server error model
The server SHALL define each error code once with its HTTP status, retryability and recovery action, and SHALL map errors to responses in a single error handler. Lease loss, run cancellation and rebase-required SHALL have their own codes. Known database conditions (deadlock, serialization failure, unique violation) SHALL map to explicit codes instead of a generic retryable failure.

#### Scenario: Worker loses its lease while committing
- **WHEN** a result commit fails because the run's lease moved
- **THEN** the failure carries the lease-lost code and is not classified as a retryable dependency failure

#### Scenario: Missing provider credential
- **WHEN** a request refers to a provider credential that does not exist
- **THEN** the response does not report the caller's API token as invalid

### Requirement: Background failures are reported
Code that deliberately continues after a failed background operation SHALL report the failure to one diagnostic sink. Startup operations SHALL NOT discard failures silently.

#### Scenario: Run recovery fails at startup
- **WHEN** restoring local agent runs fails during application start
- **THEN** the failure is recorded in diagnostics and the application continues
