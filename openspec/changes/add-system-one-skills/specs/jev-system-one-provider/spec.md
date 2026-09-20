# Spec Delta

## Purpose

Implement Jev through TypeSafe inside the full System One extension. This capability name describes its internal backend, not a separate Forage extension or an application-owned System One provider abstraction.

## ADDED Requirements

### Requirement: Jev belongs to the full System One extension
The independent System One extension SHALL own Jev model selection, TypeSafe credentials/requests, question and answer semantics, and ordinary output formatting through the generic skill-executor API. There SHALL NOT be a separate Jev-only extension or a requirement for built-in System One support in the desktop/shared host. Backend additions SHALL not require core application changes.

#### Scenario: Activate the feature
- **WHEN** the System One extension is installed, trusted, enabled and configured
- **THEN** its declared execution choice and model/configuration fields become available for user-created skills
- **AND** no LLM settings, skills or commands are created or changed automatically

### Requirement: Faithful typed TypeSafe evaluation
The extension SHALL evaluate Choice, Score and Noul through authenticated TypeSafe requests and preserve candidate identity, semantics, complete comparison sets and rubric definitions. Independent questions sharing state SHALL be batched within limits. Expanded requests exceeding bounds SHALL fail without truncation or independent partitioning of comparative Choice.

#### Scenario: Compare three ideas
- **WHEN** comparative Choice receives three candidates
- **THEN** the adapter evaluates one complete alternative set and maps probabilities to the prepared IDs

#### Scenario: Score several options
- **WHEN** candidate-specific questions share state and fit provider bounds
- **THEN** the extension batches them with explicit candidate evidence

### Requirement: Extension-owned strict answer validation
The extension SHALL reject missing/extra/duplicate/mismatched answers, unknown IDs, non-finite/out-of-range values, invalid distributions and inconsistent rubrics/legends before producing output. Distribution tolerance SHALL be documented. Noul SHALL expose yes probability without invented confidence. Core SHALL validate generic structured-output safety and reference authority, not reimplement question/answer semantics.

#### Scenario: Invalid provider response
- **WHEN** TypeSafe returns unknown options, incomplete answers, inconsistent rubrics or invalid numbers
- **THEN** the extension fails with a bounded diagnostic and emits no ranking

### Requirement: Credential isolation and controlled failure
The extension SHALL use host-scoped credentials and SHALL NOT expose them in configuration, prompts, document events, URLs, process arguments or logs. The adapter SHALL propagate cancellation, bound requests/responses/duration and classify authentication, quota/rate-limit, timeout, network and malformed-response failures without raw sensitive bodies or automatic billable retries.

#### Scenario: Expired key
- **WHEN** TypeSafe rejects authentication
- **THEN** a sanitized actionable error is returned without LLM fallback

#### Scenario: Cancel evaluation
- **WHEN** the run is cancelled before completion
- **THEN** the request is aborted and any late response cannot create output

### Requirement: Offline end-to-end verification
The full System One package SHALL provide independent build/type/test commands and mocked integration tests through generic configuration, preparation, execution and output contracts. Default checks SHALL not require real credentials, paid calls, registration in user settings or PostgreSQL.

#### Scenario: Verify without a TypeSafe key
- **WHEN** the documented offline checks run in a clean checkout
- **THEN** fixtures cover all question modes, transport/domain errors and cancellation without contacting TypeSafe

#### Scenario: Backend returns a concrete model for an alias
- **WHEN** a configured model alias resolves to a concrete model identity
- **THEN** the extension reports that identity in bounded provenance/activity without representing the alias as a pinned version
