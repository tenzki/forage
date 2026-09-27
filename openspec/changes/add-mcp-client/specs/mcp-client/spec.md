## Purpose

Allow users to connect independently supplied MCP servers and use their discovered tools in Forage agents running on the desktop or backend.

## ADDED Requirements

### Requirement: User-supplied MCP connections
The system SHALL accept user-defined stdio command configurations and remote Streamable HTTP endpoints without requiring a preset integration or Forage extension. It SHALL describe the supported transports, authentication, and required local runtimes.

#### Scenario: Unknown server
- **WHEN** a user adds a compatible server that Forage has never shipped an integration for
- **THEN** Forage discovers its tools and exposes their names and descriptions for selection

#### Scenario: Invalid or unavailable server
- **WHEN** connection configuration is invalid or discovery fails
- **THEN** Forage reports a bounded actionable error without enabling tools or exposing credentials

#### Scenario: Form-based connection
- **WHEN** a local-mode user adds an MCP server
- **THEN** they can enter a name and URL or launch command with optional credential fields without writing JSON
- **AND** JSON import remains available as an advanced option

### Requirement: Automatic connection environment
MCP Settings and the agent tool picker SHALL use the persisted mode that routes agent execution, without asking the user to choose a separate MCP environment.

#### Scenario: Server mode
- **WHEN** a user opens MCP Settings or the agent tool picker in server mode
- **THEN** Forage automatically loads the backend's MCP inventory and excludes device-local connections

#### Scenario: Backend unavailable
- **WHEN** backend inventory cannot be loaded in server mode
- **THEN** Forage reports the failure and offers retry without falling back to local connections

#### Scenario: Local mode
- **WHEN** a user opens MCP Settings in local mode
- **THEN** Forage shows the local connection form and device-local inventory without requesting backend inventory

### Requirement: Discover configured connections without execution
In local mode, MCP Settings SHALL discover connections from supported clients' user-level configuration files, display their sources, and offer explicit import. Discovery SHALL NOT launch MCP commands, authorize tools, expose credential values, change another client's files, or scan project configuration.

#### Scenario: Pen registered with another client
- **WHEN** a supported client has a compatible Pen MCP entry
- **THEN** Forage shows the connection and its source with a Connect action without requiring the user to copy its launch command

#### Scenario: Credentials or unsupported settings
- **WHEN** a discovered configuration references credentials unavailable to Forage or uses unsupported client-specific settings
- **THEN** Forage requests the needed values or identifies the unsupported settings without silently dropping them

#### Scenario: Source changes before import
- **WHEN** the source configuration changes after discovery
- **THEN** Connect refuses that candidate and asks the user to scan again

#### Scenario: Permission review after connecting
- **WHEN** a user connects a discovered server
- **THEN** Forage offers tool review and agent selection in the same flow and enables only the reviewed tools for explicitly selected agents when the user saves

### Requirement: Environment-owned connection authority
The system SHALL keep desktop connections and secrets device-local and backend connections and secrets under backend operator control. Portable agent configuration SHALL contain tool references only.

#### Scenario: Backend execution without desktop
- **WHEN** a backend agent calls an authorized MCP tool
- **THEN** the backend connects using its own configuration and credentials without requiring a desktop process

#### Scenario: Backend inventory
- **WHEN** an authenticated user with agent read access loads backend MCP inventory
- **THEN** the response contains tool metadata and sanitized status but no commands, environment values, headers, or credentials

### Requirement: Individual tool authorization and stable identity
The system SHALL assign stable collision-resistant identities to discovered tools and apply existing global, agent, and execution policy independently to each tool. Discovery SHALL NOT authorize a tool.

#### Scenario: New tool appears
- **WHEN** refresh discovers an additional server tool
- **THEN** the tool remains disabled until explicitly enabled and selected for an agent

#### Scenario: Unauthorized call
- **WHEN** a model requests a tool outside the admitted allowlist
- **THEN** no MCP request is sent for that call

### Requirement: Inventory changes are explicit
The system SHALL detect changed tool definitions and require renewed authorization after refresh. A run SHALL NOT silently execute a different definition than the one admitted.

#### Scenario: Schema changes before execution
- **WHEN** the connected server returns a changed schema for an admitted tool
- **THEN** the run fails before invoking that tool and directs the user to refresh its inventory

### Requirement: Bounded MCP execution
The system SHALL preserve discovered argument schemas, forward admitted calls, report tool errors, and bound discovery, execution time, and textual results. It SHALL close connections and child processes after completion, failure, and cancellation.

#### Scenario: Successful tool use
- **WHEN** an agent calls an admitted tool with valid arguments
- **THEN** the configured MCP server receives the call and the model receives the bounded result through normal tool activity

#### Scenario: Cancellation
- **WHEN** a run is cancelled during an MCP call
- **THEN** Forage cancels outstanding work and releases that run's clients and subprocesses

### Requirement: No automatic replay of external actions
The system SHALL NOT automatically retry MCP calls or replay MCP-enabled agent turns after an uncertain failure.

#### Scenario: Connection lost after mutation
- **WHEN** a connection fails after the server may have performed an external action
- **THEN** Forage reports the failure without automatically repeating the call or agent turn
