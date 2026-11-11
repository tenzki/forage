## Purpose

Keep the desktop interface responsive while the native layer reads, writes and synchronizes, and keep stored connection state consistent.

## ADDED Requirements

### Requirement: Storage off the main thread
Native commands that touch SQLite, the asset store or the filesystem SHALL NOT run on the main thread or block the asynchronous runtime.

#### Scenario: Locked database
- **WHEN** the database is busy for several seconds
- **THEN** the window keeps responding to input

### Requirement: Binary asset transfer
Asset bytes SHALL cross the native boundary as binary data, and reading an asset SHALL verify its hash once.

#### Scenario: Reading a 5 MB image
- **WHEN** the frontend reads a 5 MB image asset
- **THEN** the transferred size is about 5 MB

### Requirement: Bounded reads
Commands that return events, runs or activity SHALL accept a limit and return at most that many records.

#### Scenario: Large backlog
- **WHEN** the frontend asks for events after an old sequence in a long history
- **THEN** it receives one page and a way to request the next

### Requirement: Atomic connection changes
Connecting to and disconnecting from a server SHALL each change the stored credential, server configuration and storage mode in one transaction. A failed enrollment SHALL leave no credential behind, and replacing a connection SHALL remove the previous credential.

#### Scenario: Enrollment fails at outline creation
- **WHEN** enrollment stores a device token and the following request fails
- **THEN** no device token or server configuration remains

#### Scenario: Disconnect interrupted
- **WHEN** the application stops during disconnect
- **THEN** the store is either fully connected or fully disconnected on next start

### Requirement: Testable server transport
Server HTTP transport, asset upload and download, and enrollment SHALL be implemented in a client that does not depend on application state handles, and SHALL be covered by tests against a local stub server.

#### Scenario: Downloaded asset has the wrong hash
- **WHEN** a stub server returns bytes that do not match the requested asset identifier
- **THEN** a test observes the download being rejected

### Requirement: Typed run status
Agent run status SHALL be a closed set of values with one definition of which are terminal and which are retryable.

#### Scenario: New status added
- **WHEN** a status is added
- **THEN** every place that decides terminal or retryable is updated by the compiler

### Requirement: Page resources always close
Closing a page resource SHALL close its webview even when removing its native clip fails.

#### Scenario: Clip removal fails
- **WHEN** clip removal returns an error during close
- **THEN** the webview is closed and the error is reported afterwards

### Requirement: Scoped webview capabilities
Application capabilities SHALL name the trusted webview explicitly, and the sidecar spawn permission SHALL resolve the script path inside the application's resources.

#### Scenario: Remote page webview
- **WHEN** a page webview attempts an application command
- **THEN** the capability configuration, not only the handler guard, denies it
