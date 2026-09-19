# extension-packages Specification

## Purpose
Provide explicit installation and maintenance of packages using Forage's native extension format without coupling normal agent runs or synchronized configuration to package downloads.

## Requirements

### Requirement: Forage extension package format
An extension root SHALL contain a valid versioned `forage.extension.json` declaring stable identity, display metadata, version, entry point, API version, tools, hooks, and configuration fields. Forage SHALL reject unsupported manifest or API versions, paths escaping the extension root, duplicate contribution identifiers, and packages that only provide a Pi manifest.

#### Scenario: Inspect a compatible package
- **WHEN** a source contains a supported manifest
- **THEN** Forage can show its identity, compatibility, and declared contributions without importing executable code

#### Scenario: Select a Pi extension package
- **WHEN** a source contains `pi.extensions` or Pi extension files but no valid Forage manifest
- **THEN** Forage reports that the package is not a Forage extension and does not load its code

### Requirement: Explicit installation from supported sources
Extensions settings SHALL accept npm package specifications, Git repositories with optional refs, and local package directories. Forage SHALL display the requested source, resolved revision when available, declared contributions, and trusted-code implications before registration. Package operations SHALL work without a model credential and SHALL NOT require or invoke the Pi CLI or Pi package-management APIs.

#### Scenario: Install a versioned npm package
- **WHEN** a user explicitly installs `npm:example-forage-tools@1.2.3`
- **THEN** Forage installs it in managed local storage and displays the requested source, resolved version, manifest, and installation result
- **AND** installation does not trust, enable, configure, or authorize its tools

#### Scenario: Register a local development package
- **WHEN** a user adds the repository's `packages/extensions` directory as a local source
- **THEN** Forage references that directory without copying, deleting, or changing its files

#### Scenario: Package prerequisite is unavailable
- **WHEN** a required package-manager or Git executable is unavailable
- **THEN** Settings reports the missing prerequisite and retains the last working installation

### Requirement: Forage-owned device configuration
Package registrations, enabled sources, trust decisions, resolved revisions, and non-secret extension settings SHALL be stored under `~/.forage`, with managed installations isolated from the application bundle and any Pi installation. Secret settings SHALL use the native credential boundary. Relative configured paths SHALL resolve against the Forage configuration directory. Invalid configuration SHALL produce a recoverable diagnostic without overwriting the original file.

#### Scenario: Start after editing configuration
- **WHEN** `~/.forage/settings.json` contains invalid syntax or an invalid source entry
- **THEN** Forage explains the error and does not rewrite the file or import the invalid source

#### Scenario: Save a secret extension setting
- **WHEN** a user saves a manifest-declared secret in the generated configuration form
- **THEN** its plaintext is absent from `~/.forage/settings.json`, synchronized configuration, and extension diagnostics

### Requirement: Offline and explicit package lifecycle
Forage SHALL provide install, check-for-updates, update, remove, enable, disable, and reload operations. Normal startup, discovery, catalog refresh, and invocation SHALL NOT contact registries, clone repositories, install dependencies, or update code. Pinned versions or refs SHALL remain pinned unless the user changes the requested source.

#### Scenario: Run with an installed package while offline
- **WHEN** an enabled package and its dependencies are installed and no network is available
- **THEN** catalog validation and local tools that do not require network continue to work

#### Scenario: Configured package is absent
- **WHEN** a configured package is missing from managed storage
- **THEN** Forage marks it unavailable and offers installation without downloading it automatically

#### Scenario: Open Extensions settings
- **WHEN** the user views or refreshes the Extensions list
- **THEN** Forage inventories local state without silently checking a registry or Git remote

### Requirement: Recoverable installation and updates
Managed installs and updates SHALL use staging and switch registrations only after dependency, manifest, and entry validation succeeds. Dependency lifecycle scripts SHALL be disabled in v1. A failed operation SHALL preserve the previous working revision. Package changes SHALL NOT invalidate active runs.

#### Scenario: Dependency installation fails during update
- **WHEN** a managed update cannot install dependencies or validate its entry
- **THEN** Forage reports the failure and retains the previously active revision for future runs

#### Scenario: Package requires an install script
- **WHEN** a dependency requires a lifecycle script to become usable
- **THEN** v1 installation reports the unsupported requirement instead of running the script

### Requirement: Scoped removal
Removal SHALL unregister the source and delete only Forage-managed package data after active users release it. It SHALL never delete a registered external directory. Configured tool references SHALL remain visible as unavailable after removal.

#### Scenario: Remove a local development source
- **WHEN** a user removes the registered `packages/extensions` source
- **THEN** Forage removes its registration but leaves the repository and extension files intact
