# Spec Delta

## MODIFIED Requirements

### Requirement: Host-independent extension API
The repository SHALL contain packages/extension-api, named @forage/extension-api, defining one current public contract for manifests, setup, tools, lifecycle hooks, settings, generic skill executors, declarative per-skill configuration, input preparation/preview, ordinary structured results, progress, logging and cancellation. It SHALL NOT expose or depend on Pi, React, Tauri, application internals or any System One domain types. The contract SHALL be updated in place without parallel versions, API/manifest version negotiation or legacy extension adapters. The reference extension, fixtures and documentation SHALL be updated to match.

#### Scenario: Typecheck an extension without the application
- **WHEN** an author imports defineExtension and public types in a standalone TypeScript extension project
- **THEN** it typechecks without an agent SDK or application imports

#### Scenario: Underlying agent SDK changes
- **WHEN** Forage changes its embedded agent engine without changing its public extension contract
- **THEN** conforming extensions continue to use that same contract

#### Scenario: Implement a non-evaluation executor
- **WHEN** an author declares a deterministic skill executor unrelated to System One
- **THEN** it uses the same configuration, preparation, execution and output contracts without desktop or host changes

### Requirement: Documented local authoring loop
The reference project SHALL document manifests, entry modules, tools/hooks/settings, generic executor declarations, bounded configuration forms, validation/preparation, local registration, trust, reload, filtered checks and diagnostics. Documentation SHALL distinguish extension-owned feature behavior from generic application infrastructure and explain trusted-code permissions, no executable UI, local-only execution and the single current contract.

#### Scenario: Edit an extension during development
- **WHEN** a contributor edits a registered reference extension and selects Reload
- **THEN** validated changes affect new runs without copying code into the sidecar or rebuilding the desktop

#### Scenario: Author an extension-backed skill
- **WHEN** a contributor follows the System One guide
- **THEN** they register the full feature extension and select its contribution while creating their own skill
- **AND** the extension supplies declarative configuration and behavior, not commands or executable UI

### Requirement: Explicit activation of first-party extensions
Repository installation and startup SHALL NOT silently register, trust, enable, configure or select the reference or System One extension. First-party packages SHALL follow the same trust, tool authorization and explicit executor selection rules as other local packages.

#### Scenario: Install repository dependencies
- **WHEN** a contributor runs pnpm install in a clean checkout
- **THEN** extension projects become available for development without modifying device extension settings or authorizing tools/executors

## ADDED Requirements

### Requirement: Independent full System One extension
The repository SHALL provide extensions/system-one as an independently buildable/testable manifest-bearing package using only the public API. It SHALL own the complete feature: configuration declarations, domain validation, candidate preparation, Jev transport, question semantics, answer validation, ordering/filtering and ordinary output formatting. There SHALL NOT be a separate Jev-only extension or a core System One provider layer.

#### Scenario: Verify the feature independently
- **WHEN** the package runs its documented offline checks
- **THEN** its whole feature is exercised through generic public contracts without desktop startup, PostgreSQL or paid requests

#### Scenario: Remove the feature package
- **WHEN** the System One extension is not installed
- **THEN** the application still builds and runs generic/LLM skills without importing that package or offering a built-in System One executor
