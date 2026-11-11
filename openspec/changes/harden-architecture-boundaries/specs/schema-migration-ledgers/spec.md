## Purpose

Apply each database migration exactly once, in order, and know which schema a database is at.

## ADDED Requirements

### Requirement: Server migration ledger
The server SHALL record each applied migration with its name and checksum. Startup SHALL apply only unrecorded migrations, in order, each in its own transaction, while holding an advisory lock. A recorded migration whose file checksum has changed SHALL stop startup with an error.

#### Scenario: Second start
- **WHEN** the server starts against an up-to-date database
- **THEN** no migration statement runs

#### Scenario: Two instances start together
- **WHEN** two server processes start against a database missing one migration
- **THEN** the migration runs once

#### Scenario: Existing deployment
- **WHEN** the ledger is introduced on a database created by the previous migrator
- **THEN** the existing migrations are recorded as applied without being run again

### Requirement: Local schema version
The desktop event store SHALL record its schema version in the database and apply only migrations above that version, in order. It SHALL refuse to open a database whose version is newer than the application supports. It SHALL NOT decide whether a migration ran by inspecting table definitions.

#### Scenario: Database from a newer build
- **WHEN** an older application build opens a database written by a newer one
- **THEN** it reports an unsupported-schema error and changes nothing

#### Scenario: Existing database
- **WHEN** a database created before version tracking is opened
- **THEN** its version is derived once from its current shape and recorded

### Requirement: Migration list has one source
Tests SHALL load migrations through the same loader as production.

#### Scenario: Migration added
- **WHEN** a migration file is added
- **THEN** the contract tests apply it without a test edit
