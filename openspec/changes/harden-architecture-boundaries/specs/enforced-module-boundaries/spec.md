## Purpose

Turn the intended dependency directions into tests, so a boundary violation fails the build instead of waiting for a review.

## ADDED Requirements

### Requirement: Desktop import direction
The desktop source SHALL follow a declared layering in which `editor`, `sync`, `persistence`, `application` and `workspace` state do not import from `components`, and `agent` does not import from `components`. Shared types and helpers used by two layers SHALL live in the lower one. A test SHALL fail on any import that violates the declared direction or forms a directory cycle.

#### Scenario: Editor module imports a component
- **WHEN** a file under `editor` imports from `components`
- **THEN** the import-direction test fails and names the file

### Requirement: Native access through adapters
Imports of `@tauri-apps/*` SHALL be confined to an adapter directory and the transport modules listed in the boundary test. Each native command SHALL be invoked from one adapter function. Components and stores SHALL obtain native data through those adapters.

#### Scenario: Component invokes a command directly
- **WHEN** a component calls a native command without going through an adapter
- **THEN** the boundary test fails

### Requirement: Policy lives outside React
Undo grouping and history eligibility, remote projection application, synchronization scheduling, skill-run dispatch and cancellation, and server provisioning SHALL be implemented in modules that do not import React and that receive their dependencies as arguments. Each SHALL be unit-testable without rendering the application.

#### Scenario: Undo grouping test
- **WHEN** a test checks that two keystrokes within the typing window share a change group
- **THEN** it does so without rendering a component

#### Scenario: Skill run requested from a non-menu surface
- **WHEN** the activity panel or reader requests a skill run while no slash menu is mounted
- **THEN** the run starts, identified by skill identifier

### Requirement: One synchronization queue
The outline session SHALL serialize synchronization requests in one queue and deliver every resulting projection to a subscriber registered once. A request SHALL NOT lose its projection because another request was in flight.

#### Scenario: Sync requested during a sync
- **WHEN** a synchronization is requested while another is running
- **THEN** the projection that results is applied without waiting for the next timer

### Requirement: Packages typecheck themselves
Every workspace package SHALL have its own type configuration that names the ambient libraries it may use, and its own typecheck task. Packages that must run in both the webview and Node SHALL typecheck without DOM or Node ambient types. Applications SHALL NOT include package sources in their own compilation. Packages SHALL import each other by package name only.

#### Scenario: Isomorphic package uses a Node API
- **WHEN** a contract package references a Node built-in
- **THEN** that package's typecheck fails

### Requirement: Declared test projects
The default test command SHALL run each package's tests exactly once, with the test environment declared per project in one place.

#### Scenario: New package with tests
- **WHEN** a package is added
- **THEN** its tests run under its declared environment without editing a second list

### Requirement: Extension code is isolated from model credentials
Extension tools, hooks and executors SHALL run in a process that never held the model credential or another installation's secrets. An extension SHALL receive only the secrets its manifest declares.

#### Scenario: Extension tool reads its environment
- **WHEN** an enabled extension tool inspects its process environment and memory
- **THEN** it finds no model credential and no other extension's secrets

### Requirement: No unreachable agent paths
Agent loops, tool executors and skill flows that no production code reaches SHALL be removed together with their tests, and the contributor documentation SHALL describe the path that runs.

#### Scenario: Reading the agent flow documentation
- **WHEN** a contributor follows the documented agent flow
- **THEN** every function it names is called in production
