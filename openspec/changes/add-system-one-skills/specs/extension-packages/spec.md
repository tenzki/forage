# Spec Delta

## MODIFIED Requirements

### Requirement: Forage extension package format
An extension root SHALL contain a valid forage.extension.json declaring identity, display metadata, package release version, entry, tools, hooks, settings and any generic skill executors. Executor declarations SHALL include bounded display/configuration metadata inspectable without code import. The manifest SHALL use one current contract without API/manifest version discriminators, version negotiation or legacy adapters. Forage SHALL reject invalid declarations, escaping paths, duplicate contribution IDs and Pi-only manifests. Tool-only extensions SHALL remain valid without skill executors.

#### Scenario: Inspect a compatible package
- **WHEN** a source contains a supported manifest
- **THEN** Forage displays identity, validity and contributions without importing executable code

#### Scenario: Select a Pi extension package
- **WHEN** a source contains Pi extension files but no valid Forage manifest
- **THEN** Forage rejects it without loading code

#### Scenario: Inspect System One without special host support
- **WHEN** an untrusted System One package declares its generic executor and configuration
- **THEN** Forage displays its declared fields and settings through generic inventory without contacting TypeSafe or understanding question semantics

### Requirement: Scoped removal
Removal SHALL unregister a source and delete only Forage-managed package data after active users release it. It SHALL never delete a registered external directory. Configured tools, executor references and bounded non-secret skill configuration SHALL remain stored as unavailable. Saved ordinary output SHALL remain readable/editable without extension code.

#### Scenario: Remove a local development source
- **WHEN** the registered extensions/reference source is removed
- **THEN** its repository and files remain intact

#### Scenario: Remove the System One capability
- **WHEN** the System One extension is removed
- **THEN** new skills no longer offer that execution contribution and existing skills retain an unavailable reference
- **AND** saved linked results remain ordinary readable content without a built-in evaluation fallback
