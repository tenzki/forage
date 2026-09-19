# extension-authoring Specification

## Purpose
Give extension authors a stable Forage-native API and give maintainers a dedicated repository project that exercises the same public format and loading path available to users.

## Requirements

### Requirement: Host-independent extension API
The repository SHALL contain `packages/extension-api`, named `@forage/extension-api`, defining the supported manifest, setup, tool, lifecycle, configuration, result, progress, logging, and cancellation contracts. The package SHALL NOT expose or depend on Pi, React, Tauri, desktop internals, or server internals.

#### Scenario: Typecheck an extension without the application
- **WHEN** an author imports `defineExtension` and public types in a standalone TypeScript extension project
- **THEN** the project can typecheck without installing the embedded agent SDK or importing application code

#### Scenario: Underlying agent SDK changes
- **WHEN** Forage upgrades or replaces its embedded local agent engine without changing the Forage extension contract
- **THEN** a conforming extension continues to use the same manifest and public API

### Requirement: Dedicated reference extensions project
The repository SHALL contain `packages/extensions`, named `@forage/extensions`, as a pnpm workspace project with a `forage.extension.json` manifest and explicit build, typecheck, and test commands integrated with repository checks. It SHALL depend on `@forage/extension-api` and SHALL NOT import the embedded SDK or application internals.

#### Scenario: Verify the workspace project independently
- **WHEN** a contributor runs the documented filtered build, typecheck, and test commands
- **THEN** the extensions project is verified without launching the desktop, making a model request, or connecting to PostgreSQL

### Requirement: Runnable reference extension
The reference project SHALL include a deterministic `text_stats` tool with a typed bounded input schema and bounded text/JSON output. Automated verification SHALL load its manifest and entry through the same extension host used for user sources and demonstrate catalog validation, policy-controlled execution, progress/result handling, and cancellation.

#### Scenario: Load and execute the reference tool
- **WHEN** the reference package is registered, trusted, enabled, configured if necessary, and its tool is selected globally and for an agent
- **THEN** the local executor can call the tool through the Forage extension host
- **AND** automated tests verify the result without an external model or paid service

### Requirement: Documented local authoring loop
The reference project SHALL document how to create a manifest and entry module, declare tools/hooks/settings, register a local directory, review and enable it, configure its tools, reload edits, run filtered checks, and inspect diagnostics. It SHALL document API/manifest versioning, trusted-code implications, unsupported application surfaces, and local-only execution.

#### Scenario: Edit an extension during development
- **WHEN** a contributor edits the registered local reference extension and selects Reload in Extensions settings
- **THEN** new runs see the validated change without copying code into the sidecar or rebuilding the desktop bundle

### Requirement: Explicit activation of first-party extensions
Repository installation and application startup SHALL NOT silently register, trust, enable, configure, or authorize the reference extension. First-party extensions SHALL follow the same source activation and tool authorization rules as other local packages.

#### Scenario: Install repository dependencies
- **WHEN** a contributor runs `pnpm install` in a clean checkout
- **THEN** both extension workspace projects become available for development without modifying `~/.forage` or enabling example tools
