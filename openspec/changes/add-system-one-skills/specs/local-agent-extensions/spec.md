# Spec Delta

## MODIFIED Requirements

### Requirement: Native extension host API
Forage SHALL load entries through one current @forage/extension-api contract supporting tools/hooks and generic skill executors. The implementation SHALL be updated in place without parallel versioned loaders or legacy adapters. It SHALL NOT expose Pi APIs, editor objects, arbitrary executable UI or extension-defined commands. Executors SHALL validate configuration, prepare bounded inputs and execute directly into ordinary structured output without an LLM session. Core contracts SHALL NOT define System One questions, model providers, scores or filtering semantics.

#### Scenario: Register a native tool and hook
- **WHEN** an enabled extension registers a declared tool and run:start handler
- **THEN** the tool enters the validated catalog and the handler runs for an admitted local LLM run before the model starts

#### Scenario: Extension imports Pi APIs
- **WHEN** an extension expects Pi host objects or package conventions
- **THEN** validation rejects it instead of providing a partial Pi environment

#### Scenario: Register a generic skill executor
- **WHEN** a trusted enabled extension registers its declared executor
- **THEN** a user-created skill can explicitly select it and execute without Pi, LLM credentials or unrelated extension hooks

### Requirement: Observable bounded execution
Forage SHALL show bounded tool/executor activity with provenance, propagate cancellation and terminate unresponsive validation, preparation or execution processes after bounded deadlines/grace periods. Logs SHALL NOT corrupt the protocol or expose scoped secrets, including JSON-escaped secrets in nested observable fields. Source/configuration revisions and prepared input SHALL be immutable for an admitted run. Generic result nodes MAY carry a plain-text note materialized as the bullet's note and counted toward text bounds. A generic result MAY instead carry inline tag edits for host-admitted nodes: the host SHALL append missing tags as plain `#tag` text at the end of the bullet text, delete removed tags, skip tags already in place, and apply all edits in the result's single undoable transaction. Generic result validation SHALL enforce bounds and host-admitted reference IDs, reject invalid/late output and use application-owned commit paths; extensions SHALL NOT mutate the document directly.

#### Scenario: Extension tool logs and throws
- **WHEN** a tool logs and throws
- **THEN** the host parses its protocol and shows a bounded sanitized error without committing invalid output

#### Scenario: Extension ignores cancellation
- **WHEN** execution fails to stop within the cancellation grace period
- **THEN** the host terminates the process and rejects all late results

#### Scenario: Source changes before execution
- **WHEN** the selected executor digest differs from the admitted revision
- **THEN** execution fails before loading changed code or making a provider request

#### Scenario: Extension tags a node it was not given
- **WHEN** output edits tags of a node outside the host-admitted input IDs
- **THEN** host validation rejects the output without changing any bullet

#### Scenario: Extension supplies its own reference allowlist
- **WHEN** output includes a link outside host-admitted input IDs even if the extension lists it as allowed
- **THEN** host validation rejects the output without partial insertion

### Requirement: Local extensions respect execution authority
Extension installations, paths, trust, settings, secrets and source snapshots SHALL remain device-local. Portable skills SHALL contain only valid executor references and bounded non-secret configuration, not installation authority. Server-mode invocation SHALL use server authority and SHALL NOT fall back to desktop execution. Generic local extension executors SHALL be unavailable on the server in this change.

#### Scenario: Server-mode skill requires a local extension
- **WHEN** a skill needs a desktop-only tool or executor in server mode
- **THEN** admission reports unavailable execution without running desktop code

#### Scenario: Receive an unknown tool through configuration synchronization
- **WHEN** synchronized configuration references a missing tool
- **THEN** Forage retains it as unavailable without fetching, installing, trusting or executing code

#### Scenario: Receive an unknown executor and configuration
- **WHEN** synchronization delivers a missing executor reference with bounded non-secret skill configuration
- **THEN** the host preserves it without interpreting domain fields or granting execution authority

## ADDED Requirements

### Requirement: Current-contract manifest and runtime agreement
Runtime tools, hooks and generic executors SHALL exactly match static declarations. Comparison SHALL be semantic rather than sensitive to object property order. Missing/undeclared contributions, invalid forms and conflicting extension-qualified executor ownership SHALL fail closed. Invalid manifests SHALL remain unavailable with actionable diagnostics and without entry import.

#### Scenario: Entry registers an undeclared tool
- **WHEN** a manifest declares weather_lookup but the entry also registers run_shell
- **THEN** validation rejects the source without authorizing either tool

#### Scenario: Equivalent metadata uses different property order
- **WHEN** runtime and manifest metadata are semantically equal but object fields are ordered differently
- **THEN** validation accepts their agreement

#### Scenario: Duplicate active executor identities
- **WHEN** two enabled installations supply the same extension-qualified executor
- **THEN** both are unavailable with ownership diagnostics instead of a load-order winner

### Requirement: Generic skill configuration contributions
An extension MAY declare a skill execution choice and a bounded per-skill configuration schema/form description. Forage SHALL render supported generic fields, conditional branches and bounded repeated groups without extension executable UI or domain-specific controls. It SHALL reject unsupported/excessive schemas and keep secrets outside portable fields. Runtime domain validation SHALL be supplied by the trusted executor, not hardcoded by the host.

#### Scenario: Configure an unfamiliar feature
- **WHEN** an enabled extension declares an executor with a non-evaluation configuration
- **THEN** the existing skill editor renders it and saves a generic executor reference/configuration without application changes

#### Scenario: Activate an executor without creating a skill
- **WHEN** an extension becomes ready
- **THEN** its declared execution choice becomes selectable but no skill or slash command is installed

#### Scenario: Unsupported executable form
- **WHEN** a declaration requests React, HTML or another executable UI surface
- **THEN** the host rejects it and does not execute extension code in the webview

### Requirement: Bounded generic input preparation
Forage SHALL supply an immutable application-resolved context snapshot and run extension validation/preparation in a bounded trusted process without inference credentials. The snapshot SHALL use existing ancestor/local-parent/explicit-link scope, exclude the invocation subtree and image bytes, serialize nodes once and enforce 100-node/40,000-character limits. Preparation SHALL return a bounded plan of selected IDs, descriptive preview annotations and prepared data. The host SHALL verify all referenced IDs are in its snapshot and pin that plan for execution. Domain selection semantics SHALL belong to the extension; preparation SHALL NOT authorize broader outline access or document writes.

#### Scenario: Preview and execute a prepared plan
- **WHEN** preparation succeeds and the user invokes the skill
- **THEN** the validated plan shown in preview is the one admitted for execution against the pinned context/configuration/source

#### Scenario: Preparation selects an external node
- **WHEN** an executor returns an ID outside the supplied snapshot
- **THEN** the host rejects the plan before evaluation

#### Scenario: Missing or over-budget context
- **WHEN** an explicit reference is missing or the context exceeds either budget
- **THEN** no evaluation request or result insertion occurs

## REMOVED Requirements

### Requirement: Manifest and runtime agreement
**Reason**: Replace version-compatibility requirements with the single current generic executor contract.
**Migration**: Apply Current-contract manifest and runtime agreement and update the in-repository reference extension in place. No legacy extension adapter is required.
