## Purpose

Keep every server outline rule in one implementation so the in-memory and PostgreSQL repositories cannot disagree, and prove it with one suite that runs against both.

## ADDED Requirements

### Requirement: Single implementation of outline rules
The server SHALL implement capture, automation admission, event acceptance, agent result commit and agent result placement as domain functions that perform no I/O. Every repository implementation SHALL call those functions and SHALL contain only persistence. A repository SHALL NOT restate a rule that a domain function owns, including attempt limits, version checks, asset completion checks, duplicate handling and source limits.

#### Scenario: Attempt limit for an automation run
- **WHEN** an Inbox capture admits a run through either repository
- **THEN** both repositories record the same maximum attempts for the same run input

#### Scenario: Result references an unfinished asset
- **WHEN** an agent result references an image whose upload is not complete
- **THEN** both repositories refuse the commit with the same error code

### Requirement: Shared repository contract suite
One contract suite SHALL run every repository-level rule against each repository implementation. The default test command SHALL run the suite against the in-memory repository, and SHALL run it against PostgreSQL whenever the contract database is configured. HTTP tests SHALL NOT be the only coverage for a repository rule.

#### Scenario: New rule added
- **WHEN** a contributor adds a rule and a contract test for it
- **THEN** the test runs against both repositories without a second copy of the test

#### Scenario: Implementations disagree
- **WHEN** the PostgreSQL repository handles a partially duplicated event batch differently from the in-memory repository
- **THEN** the contract suite fails for the implementation that differs

### Requirement: Transactional push conflict check
The server SHALL decide whether a pushed batch is stale inside the same transaction that would accept it, after taking the outline lock. A stale batch SHALL always produce the rebase response, regardless of when the competing write landed. A batch whose events were all accepted earlier SHALL be acknowledged as a replay even when its base revision is now stale.

#### Scenario: Two devices push at the same base revision
- **WHEN** two devices push batches with the same base revision at the same time
- **THEN** one is accepted and the other receives the rebase response with the current revision

#### Scenario: Retry of an accepted batch
- **WHEN** a device resends a batch the server already accepted, after other events advanced the revision
- **THEN** the server returns the original acknowledgements and writes nothing

### Requirement: Consistent lock order
Every server transaction that writes an outline SHALL take the outline row lock before any projection lock, through one shared helper.

#### Scenario: Capture races an agent commit
- **WHEN** a capture and an agent result commit run concurrently on one outline
- **THEN** both complete and the outline revisions are contiguous

### Requirement: Scoped agent store access
Run reads and writes SHALL be scoped by outline in the store interface, so a caller cannot read a run's activity, output or transcript by run identifier alone. Outline writers SHALL settle runs through store operations that accept the writer's transaction.

#### Scenario: Run from another outline
- **WHEN** a request asks for the activity of a run that belongs to a different outline
- **THEN** the store reports the run as unavailable without a prior ownership check by the caller
