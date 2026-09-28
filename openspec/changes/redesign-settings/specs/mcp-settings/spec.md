## Purpose

Present existing MCP connection and permission capabilities as a connected-server overview, explicit setup flow, and readable tool-access details.

## ADDED Requirements

### Requirement: Connected and detected inventory sections
MCP Settings SHALL distinguish configured connections and their status from unconnected detected candidates. Local candidates SHALL show their source client and a Connect action; Scan again SHALL refresh discovery without importing connections. The overview SHALL support arbitrary inventories rather than hard-coded Pen, GitHub, or Context7 integrations.

#### Scenario: Mixed inventory
- **WHEN** one server is connected and two distinct candidates are detected
- **THEN** the connected server offers management and access status, and each candidate independently offers Connect
- **AND** an already imported unchanged candidate is not offered again as an unconnected duplicate

#### Scenario: Discovery is empty or incomplete
- **WHEN** no candidate is found or some configuration files cannot be read
- **THEN** existing connections remain visible with an empty or partial-discovery explanation and manual Add server remains available

### Requirement: Single manual-add entry point
The overview SHALL provide Add server leading to dedicated setup, with Server URL selected initially, Launch command as the alternative, and JSON import in a collapsed disclosure. URL setup SHALL support an optional token and additional headers; command setup SHALL support environment variables and an optional working directory. The overview SHALL NOT duplicate this form inline.

#### Scenario: Connect by URL
- **WHEN** a local-mode user chooses Add server
- **THEN** URL setup opens and permits connection without writing JSON
- **AND** connecting is followed by explicit tool and agent review without automatic authorization

#### Scenario: Configure a command
- **WHEN** the user selects Launch command
- **THEN** command-specific fields and relevant execution guidance replace URL-specific fields
- **AND** secrets or fields from the other method are not accidentally submitted

### Requirement: Automatic environment and backend limitations
MCP Settings SHALL follow persisted workspace execution mode with no separate device/backend choice. Server mode SHALL show backend inventory and operator-managed connection status, hide local discovery and local connection mutations, and retain applicable authorized permission editing. Backend failure SHALL offer retry without displaying desktop connections as a fallback.

#### Scenario: Server-managed inventory
- **WHEN** server mode is active
- **THEN** the overview explains that connection setup is managed on the server and omits device Scan and Add actions
- **AND** backend tool metadata is presented without executable commands or secrets

### Requirement: Compact expandable tool review
Server detail SHALL place Refresh tools near the tool heading and display each tool's title and a one-line description preview with an explicit expand action for its complete bounded description. Expansion SHALL NOT toggle authorization. Saving tool and agent access SHALL grant only the reviewed selection and expose validation or persistence errors without claiming success.

#### Scenario: Long tool description
- **WHEN** a tool description exceeds the row's available width
- **THEN** the row remains one line with truncation and an accessible disclosure
- **AND** expanding reveals the description without changing its permission

#### Scenario: Refresh reveals a changed definition
- **WHEN** Refresh tools detects a new or changed tool definition
- **THEN** the detail view identifies the need for review and retains existing authorization safeguards
- **AND** refreshing alone grants no additional access

### Requirement: Truthful server identity
Server names SHALL come from sanitized connection metadata and every server SHALL have a neutral fallback icon. A familiar name SHALL NOT imply a verified brand logo or preset integration. Missing or invalid optional icon metadata SHALL NOT prevent inspection or connection management.

#### Scenario: Server has no icon
- **WHEN** a detected or connected server supplies no usable icon
- **THEN** the overview and detail use the same neutral fallback with the server's readable name
