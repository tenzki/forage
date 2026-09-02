## ADDED Requirements

### Requirement: Eligible Inbox capture admission
The server SHALL evaluate automation only for a newly committed Notes API capture whose resolved parent is the current canonical Inbox. It SHALL admit all matched, de-duplicated skill runs in the same transaction as the capture and SHALL return the Notes API response without waiting for agent execution.

#### Scenario: Match an Inbox capture
- **WHEN** a valid API capture resolves to canonical Inbox and an enabled policy matches its source properties
- **THEN** the transaction commits the capture and one queued run per resolved skill before returning the unchanged create-note response

#### Scenario: Capture outside Inbox
- **WHEN** a caller supplies a valid writable parent other than canonical Inbox
- **THEN** the server creates the note and admits no automatic run

### Requirement: Declarative policy matching
The owner SHALL be able to publish ordered, versioned, enabled or disabled policies using bounded source equality, source kind, URL host/type, and related declarative predicates. Matching SHALL be deterministic, repeated skills SHALL be de-duplicated in priority order, and a policy MAY select multiple configured skills.

#### Scenario: Match a YouTube policy
- **WHEN** source metadata contains a valid known YouTube video URL matching an enabled policy
- **THEN** the matcher resolves the policy's ordered skills once each without invoking a model for routing

#### Scenario: Multiple policies repeat a skill
- **WHEN** multiple matching policies select the same skill plus distinct skills
- **THEN** the repeated skill is admitted once and distinct skills retain deterministic priority order

#### Scenario: Disabled policy matches
- **WHEN** capture properties satisfy a disabled policy
- **THEN** that policy contributes no runs

### Requirement: Bounded dispatcher classification
An automation policy MAY explicitly delegate ambiguous or mixed content classification to a configured dispatcher agent. The dispatcher SHALL choose only from the policy's bounded skill IDs, SHALL receive no write-capable tool, and SHALL NOT override deterministic eligibility or tool authorization.

#### Scenario: Classify an ambiguous capture
- **WHEN** an eligible capture matches a dispatcher policy but no deterministic source-type branch selects a skill
- **THEN** the dispatcher returns a validated subset of configured skill IDs and the server admits only those skills

#### Scenario: Dispatcher invents a skill
- **WHEN** dispatcher output names an ID outside its allowed set
- **THEN** the server rejects that ID and records a sanitized classification failure without invoking it

### Requirement: Immutable published automation configuration
Server-mode automation SHALL use an explicitly published configuration revision containing validated policy and agent/skill snapshots without secrets. Each admitted run SHALL pin the revision and resolved snapshots active when the capture commits.

#### Scenario: Publish with stale revision
- **WHEN** a client publishes policies against a configuration revision that is no longer current
- **THEN** the server rejects the update with a revision conflict and preserves the current configuration

#### Scenario: Edit policy after capture
- **WHEN** a capture has admitted runs and the owner later disables or changes its policy
- **THEN** the admitted runs retain their original snapshots and later captures use the new revision

### Requirement: Capture preservation and result placement
Automation SHALL preserve the original captured note as ordinary editable Inbox content. Successful output SHALL be added as ordinary agent-provenance content beneath the stable capture target unless the target is no longer live, and SHALL NOT silently replace, move, or delete the capture.

#### Scenario: Complete link enrichment
- **WHEN** a link-processing run returns valid structured notes and the capture remains live
- **THEN** the server attaches the result under the capture with run, skill, tool, and source provenance while leaving capture text and source metadata intact

#### Scenario: User moves the capture
- **WHEN** the user moves a live capture elsewhere before its run completes
- **THEN** completion resolves the same stable note ID and attaches beneath its new live location

### Requirement: Idempotent triggers and recursion prevention
The server SHALL uniquely identify automation admission by the original capture trigger, published revision, and skill. Replaying the capture idempotency key, retrying a worker, or accepting agent-generated result notes SHALL NOT create additional automatic runs.

#### Scenario: Retry the Notes API request
- **WHEN** a caller repeats an identical accepted create-note request with the same credential and idempotency key after configuration changed
- **THEN** the server returns the original response and admits no additional or updated run

#### Scenario: Agent output enters the Inbox subtree
- **WHEN** a server worker appends result notes below an Inbox capture
- **THEN** those agent-origin events do not trigger Inbox automation

### Requirement: Opt-in controls and failure isolation
Automatic processing SHALL remain disabled until the owner publishes a valid enabled policy and usable credentials. The owner SHALL be able to disable admission, cancel individual runs, inspect sanitized failures, and retry deliberately. A failed run SHALL NOT roll back or hide its capture.

#### Scenario: No automation profile exists
- **WHEN** the Notes API accepts an Inbox capture before automation is configured
- **THEN** only the capture is committed and returned

#### Scenario: Enrichment provider fails
- **WHEN** a provider failure exhausts the admitted run's retries
- **THEN** the run is marked failed with a sanitized code and the original Inbox item remains available
