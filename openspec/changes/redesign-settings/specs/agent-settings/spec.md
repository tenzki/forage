## Purpose

Make agent instructions and tool permissions editable in one clear flow while preserving tool provenance and explicit authorization.

## ADDED Requirements

### Requirement: Dedicated agent editor
Agents SHALL provide an explicit editing view for name, description, instructions, and allowed tools, with Save and Cancel. Saving SHALL apply to subsequent admissions while retaining existing publication and validation behavior. The editor SHALL identify the inherited environment model and offer navigation to Connection rather than a per-agent model override.

#### Scenario: Cancel edits
- **WHEN** a user cancels an edited agent draft
- **THEN** its saved instructions, permissions, and published configuration remain unchanged

#### Scenario: Save while a run is active
- **WHEN** agent edits are saved while that agent has an admitted run
- **THEN** the active run retains its admitted configuration and later runs use the saved revision

### Requirement: Unified tool selection with source information
The editor SHALL show built-in, custom, and extension tools in its ordinary tools list with readable source labels. It SHALL NOT require a separate Extensions selector. Availability reasons and saved references SHALL remain visible when tools are disabled, missing, or unsupported in the active environment. Agent selection SHALL NOT bypass global enablement or trust requirements.

#### Scenario: Enable Text statistics
- **WHEN** Text Stats contributes an available globally enabled tool
- **THEN** Text statistics appears beside other tools with Text Stats identified as its extension source
- **AND** the user can select it directly for the agent

#### Scenario: Local-only extension in server mode
- **WHEN** an agent references a device-local extension tool while server execution is authoritative
- **THEN** the editor retains the reference with an unavailable reason
- **AND** selecting or saving the agent does not authorize desktop fallback

### Requirement: Per-server MCP selection without a master switch
The editor SHALL expose applicable connected MCP servers with per-server access controls, selected-tool counts, and a Choose tools action. It SHALL NOT add an Allow MCP tools master toggle. Server access controls SHALL operate on explicitly selected individual tools; enabling a server SHALL NOT grant unreviewed or newly discovered tools. Disabling server access SHALL remove that server's effective agent grants only.

#### Scenario: First enablement of a server
- **WHEN** a user enables a server for an agent with no reviewed tool selection
- **THEN** the editor opens tool selection before access can be saved
- **AND** canceling review grants nothing

#### Scenario: Disable one server
- **WHEN** a user disables Pen for an agent and saves
- **THEN** Pen tools are excluded from that agent's future runs
- **AND** the connection and other agents' access remain unchanged

#### Scenario: Server inventory changes
- **WHEN** a connected server gains tools or changes an authorized definition
- **THEN** those definitions are not included by the server-level switch until explicitly reviewed under MCP policy
