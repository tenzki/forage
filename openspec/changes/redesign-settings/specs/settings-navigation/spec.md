## Purpose

Provide a coherent settings hierarchy for preferences, connections, agents, extensions, and MCP tools while keeping recovery actions accessible.

## ADDED Requirements

### Requirement: Ordered settings navigation
Settings SHALL open on General and list General, Connection, Agents, Extensions, and MCP servers in that order. Nested pages SHALL retain their parent section selection and offer a return action. Advanced SHALL NOT be a top-level section.

#### Scenario: Enter Settings
- **WHEN** a user opens Settings from the outline
- **THEN** General is selected and all five sections are reachable by keyboard

#### Scenario: Return from nested setup
- **WHEN** a user returns from Add provider, an agent editor, extension details, or MCP setup
- **THEN** the corresponding parent section remains selected
- **AND** focus returns to the originating action or an appropriate list fallback

### Requirement: Honest asynchronous settings actions
Settings SHALL distinguish loading, empty, unavailable, validation-error, and saved states. Failed saves SHALL retain editable drafts without claiming success. Leaving a dirty explicit-save editor SHALL offer to keep editing or discard changes; preference controls identified as automatic-save controls SHALL report persistence failures.

#### Scenario: Agent save fails
- **WHEN** saving an edited agent fails
- **THEN** its draft remains available with an actionable error and a retry action
- **AND** the editor does not silently navigate away

### Requirement: Server connection and recovery placement
Connection SHALL own workspace mode, provisioning, server readiness, and collapsed connection/recovery details. Agents SHALL NOT present a Server agent executor control. The relocation SHALL retain explicit enrollment, credential provisioning, conflict handling, and Inbox link-rule editing without adding a second execution-location selector.

#### Scenario: Server is unavailable
- **WHEN** the persisted workspace mode is server and the connection fails
- **THEN** Connection shows the failure and applicable recovery actions
- **AND** agent execution does not silently switch to the desktop

#### Scenario: Inspect agents in server mode
- **WHEN** a user opens Agents
- **THEN** agent, skill, and applicable Inbox rule editing remain available
- **AND** runtime readiness and configuration recovery are reached through Connection

### Requirement: Nested diagnostics
General SHALL provide a Diagnostics entry with connection checks, actionable status, collapsed technical details, and a sanitized report-copy action. Routine settings SHALL NOT expose development paths or runtime implementation details as primary content. Diagnostics SHALL NOT disclose credentials, tokens, or secret-bearing MCP configuration.

#### Scenario: Diagnose a failed component
- **WHEN** a user runs diagnostic checks
- **THEN** independent component results identify pending, ready, unavailable, or setup-required states without concealing other results
- **AND** the user can copy a sanitized report and navigate to relevant setup
