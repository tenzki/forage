## Purpose

Help new desktop users create durable notes, connect an AI provider, run a first command, and optionally configure extensions and MCP tool connections through a minimal, resumable setup flow.

## ADDED Requirements

### Requirement: Minimal onboarding presentation
The desktop SHALL present five ordered onboarding steps: first note, AI connection and model selection, first command and result, optional extension selection and configuration, and optional MCP connection. Each screen SHALL contain brief instructions, the applicable editor or configuration controls, and bottom navigation in a plain application window. The full workspace sidebar, toolbar, Activity panel, and tutorial progress rail SHALL remain outside this presentation.

#### Scenario: Start onboarding
- **WHEN** a user enters onboarding
- **THEN** the first screen presents instructions and an editable note area
- **AND** subsequent screens use the same minimal presentation with a compact step indicator and bottom navigation

### Requirement: First-run eligibility and recovery
The desktop SHALL automatically offer onboarding on a newly initialized local installation after document and settings loading succeeds. An existing installation without onboarding metadata SHALL open its normal workspace on upgrade. Users SHALL be able to explicitly start or resume onboarding from General settings in local mode. Document or settings load failures SHALL retain their recovery flow and SHALL NOT be interpreted as a new installation. Onboarding SHALL NOT change execution mode or enroll a server.

#### Scenario: New local installation
- **WHEN** a local installation has no prior durable outline or settings and initializes successfully
- **THEN** onboarding opens at the first-note step

#### Scenario: Upgrade an existing installation
- **WHEN** prior durable data exists but onboarding metadata is absent
- **THEN** the normal workspace opens without an onboarding interruption
- **AND** an explicit onboarding entry point remains available in General settings

#### Scenario: Existing data cannot be loaded
- **WHEN** the outline or settings fails to load
- **THEN** the existing error and recovery UI remains available
- **AND** onboarding does not create replacement content or reset settings

### Requirement: Real first-note editing
The first-note area SHALL edit the user's ordinary outline using stable bullet identities, nesting, normal persistence, and durable undo. Instructional placeholders and sample copy SHALL NOT be inserted as user content automatically. Continuing from this step SHALL require a nonempty user note and successful persistence of its pending edits. Back, skip, and completion SHALL preserve the note.

#### Scenario: Write and nest a note
- **WHEN** a user writes a topic, presses Enter, and uses Tab to nest a detail
- **THEN** those bullets become ordinary content in the same outline used by the workspace
- **AND** restarting or completing onboarding retains their content and identities

#### Scenario: First note cannot be saved
- **WHEN** pending note edits cannot be persisted
- **THEN** onboarding displays the save failure and keeps the editor available for recovery
- **AND** Continue does not claim the note is saved

### Requirement: Explicit AI connection and default selection
AI setup SHALL offer the locally supported providers, authentication methods, and model catalog through the same credential authority and validation used by Settings. It SHALL distinguish pending, failed, and verified connections, and SHALL require explicit confirmation of a valid default provider/model selection before offering the first AI command. Secret values SHALL remain outside outline content and onboarding metadata. The user SHALL be told that the selected note context is sent to the chosen provider when a command runs.

#### Scenario: Connect and select a model
- **WHEN** provider authentication succeeds and the user confirms a supported model
- **THEN** the local default selection is saved through the existing settings authority
- **AND** onboarding offers the first-command step using that selection

#### Scenario: Authentication fails or is canceled
- **WHEN** authorization fails, expires, or is canceled
- **THEN** onboarding presents a sanitized retryable state without claiming the provider is connected
- **AND** the user's note and any previously committed connection remain intact

### Requirement: Optional AI setup
The user SHALL be able to skip AI setup or leave onboarding and use the local outline without an account or network access. Skipping unconfigured AI SHALL bypass the first-command step with a clear explanation and continue to optional extension/MCP setup or the workspace. MCP discovery and connection SHALL NOT require a model credential. It SHALL NOT fabricate a successful run or select another provider implicitly.

#### Scenario: Continue without AI
- **WHEN** a user skips AI setup without a usable default model
- **THEN** onboarding retains the first note and bypasses the AI command
- **AND** the user can finish setup and edit the outline locally

### Requirement: Explicit first command on the user's note
The command step SHALL use the user's first note and an editable `/brainstorm` request. Running SHALL require an explicit Enter or Run command action and SHALL use the existing context selection, credential admission, tool policy, cancellation, and ordinary result-placement behavior. The UI SHALL identify the notes included in the request. Entering, revisiting, or resuming the step SHALL NOT initiate a model call.

#### Scenario: Run the first command
- **WHEN** a user explicitly runs `/brainstorm` beneath their first note
- **THEN** the assistant receives the normal bounded branch-local and explicitly referenced context
- **AND** validated results appear beneath that invocation as editable outline content

#### Scenario: Revisit a completed command
- **WHEN** a user returns to the command step after a result has been committed
- **THEN** onboarding displays the existing invocation and result
- **AND** it does not rerun the command or insert another result automatically

#### Scenario: Command fails or is interrupted
- **WHEN** the first run fails, is canceled, or is interrupted by restart
- **THEN** existing run recovery and result-retention rules apply and the user sees an actionable state
- **AND** retry requires another explicit user action

### Requirement: Editable first result
The result screen SHALL show actual committed output in the same outline editor and permit normal editing and undo. It SHALL preserve user edits when navigating away or entering the workspace and SHALL NOT require an Activity conversation or a second agent run to complete onboarding.

#### Scenario: Edit an assistant idea
- **WHEN** a user changes one generated idea and continues
- **THEN** the edited result remains in the outline
- **AND** normal document undo remains available

### Requirement: Optional extension selection
The extension step SHALL offer a bounded set of compatible installed or application-supplied extensions using inspectable source and contribution metadata. Choices SHALL describe their capabilities and account or runtime prerequisites. Initial choices SHALL remain unselected until the user selects them. Selection SHALL NOT install, import, trust, enable, configure, or grant tools. **Skip for now** SHALL appear in bottom onboarding navigation beside **Configure selected** and SHALL leave unconfigured selections without new side effects.

#### Scenario: Select an extension
- **WHEN** a user selects Image Generation
- **THEN** the UI identifies it as selected and offers configuration
- **AND** selection alone performs no package operation, code activation, or permission grant

#### Scenario: Skip extensions
- **WHEN** a user chooses Skip for now in onboarding navigation
- **THEN** setup proceeds to optional MCP setup with already saved notes and AI settings preserved
- **AND** selected but unconfigured extensions are not installed or enabled

#### Scenario: An extension is unavailable
- **WHEN** a source is incompatible or its required package or runtime is absent
- **THEN** the UI explains its unavailable state and offers applicable recovery or skipping
- **AND** it does not display a fabricated ready state

### Requirement: Configuration preserves extension authority
Selected extensions SHALL use the existing explicit installation preview, source review, trust, configuration, global tool policy, agent selection, and user-created skill boundaries. Configuration controls SHALL be application-rendered. A source requiring installation SHALL be registered only after explicit source review and installation confirmation. Trust and new tool grants SHALL require explicit choices; selecting or enabling a source SHALL NOT grant them implicitly. Extension-owned credentials SHALL remain separate from model-provider credentials, and incomplete prerequisites SHALL be reported honestly.

#### Scenario: Configure Image Generation
- **WHEN** a user configures Image Generation
- **THEN** the form exposes its own supported authentication choices and required settings
- **AND** a ChatGPT model connection is not treated as proof of a usable Codex image login
- **AND** source trust, global Generate images access, and assistant tool selection remain explicit decisions

#### Scenario: Create an extension command
- **WHEN** a user confirms creation of a slash skill with a valid unique label and applicable agent or executor settings
- **THEN** the skill is saved through ordinary skill configuration
- **AND** canceling or revisiting configuration does not create or duplicate a skill

#### Scenario: Configure several selected extensions
- **WHEN** a user selects multiple extensions and one fails setup
- **THEN** saved configuration for successful extensions remains intact
- **AND** the failed source can be retried or skipped without falsely reporting it as enabled

### Requirement: Navigation and device-local resumption
Onboarding SHALL preserve successful saves when navigating Back and SHALL persist non-secret progress independently of document content, credentials, and effective extension/MCP policy. Pausing SHALL allow explicit resumption from General settings; closing the application during incomplete onboarding SHALL resume the saved step on next successful local startup. Resume SHALL revalidate referenced notes, runs, accounts, models, extension sources, and saved MCP inventory identities and SHALL require fresh action for unfinished authentication, runs, package operations, and MCP connection/discovery operations.

#### Scenario: Resume after restart
- **WHEN** the application closes during incomplete onboarding and restarts successfully
- **THEN** onboarding restores its saved step and previously saved content and configuration
- **AND** it does not automatically initiate authentication, model calls, package operations, or MCP commands/connections

#### Scenario: Saved setup references are no longer usable
- **WHEN** a saved note was deleted, a credential was revoked, an extension revision changed, or a saved MCP connection/tool definition changed
- **THEN** onboarding explains and routes to the affected step for repair or skipping
- **AND** it does not recreate the note, replace the account, retrust the changed source, or grant changed MCP definitions automatically

### Requirement: Optional MCP setup
After extensions, onboarding SHALL offer device-local MCP setup with configured connections, detected candidates, manual Add server, and bottom-navigation Skip for now. Skipping SHALL advance to completion without importing pending candidates or connecting draft servers. Saved connections and existing permissions SHALL remain intact under existing inventory-validation rules. Individual tool and assistant permissions SHALL be configured later in Settings → MCP servers rather than on a detailed onboarding screen. No MCP tool invocation SHALL be required to finish setup.

#### Scenario: Skip all MCP configuration
- **WHEN** a user chooses Skip for now before connecting a server
- **THEN** onboarding proceeds to completion with MCP identified as skipped
- **AND** the existing note, AI selection, and extension configuration remain intact

#### Scenario: Continue after connecting
- **WHEN** a user saves a connection and continues onboarding
- **THEN** the connection remains configured and onboarding can proceed without a tool-permission step
- **AND** it explains that tool access can be configured later in Settings

### Requirement: Explicit local MCP discovery and import
The MCP step SHALL offer an explicit action to scan supported clients' user-level configuration and display sanitized candidates with their source client. Scanning SHALL NOT launch commands, connect endpoints, import entries, enable tools, modify another client's files, or scan project configuration. Connect SHALL revalidate the chosen candidate, request missing supported credentials, and use existing connection discovery before returning to the configured inventory. Entering or resuming the step SHALL NOT automatically launch discovery or connect servers.

#### Scenario: Import a detected connection
- **WHEN** a user explicitly scans, selects a compatible candidate, supplies missing credentials, and chooses Connect
- **THEN** Forage imports that connection through device-local authority and discovers its tool metadata
- **AND** no tools or assistants receive automatic grants and the UI directs later access configuration to Settings

#### Scenario: Scan is empty or incomplete
- **WHEN** no candidate is found or some supported configuration files cannot be read
- **THEN** onboarding shows an empty or partial-discovery explanation while preserving configured connections
- **AND** manual Add server, retry, and Skip for now remain available

#### Scenario: Candidate changes after scan
- **WHEN** a candidate's source definition changes before import
- **THEN** Connect refuses the stale candidate and offers a new scan
- **AND** no configuration or secret is silently substituted

### Requirement: Manual MCP connection configuration
Add server SHALL provide a named Server URL form initially, a Launch command alternative, and optional JSON import. URL setup SHALL support a token and additional headers; command setup SHALL support arguments, environment variables, and working directory. Only the selected method's fields SHALL be submitted. Command setup SHALL explain that the supplied command runs on the user's device. Configuration and credentials SHALL use existing MCP storage/validation; secrets SHALL NOT enter onboarding metadata, outline content, or diagnostics.

#### Scenario: Connect an MCP endpoint
- **WHEN** a user submits a supported server URL and applicable authentication
- **THEN** existing bounded discovery validates and saves the local connection and returns to the configured inventory
- **AND** a connection failure shows a sanitized retryable error without granting tools

#### Scenario: Switch to a launch command
- **WHEN** a user chooses Launch command after editing URL fields
- **THEN** only the command configuration is submitted on explicit Connect
- **AND** URL tokens/headers are not carried into the command configuration

### Requirement: MCP permissions remain in Settings
Onboarding SHALL limit MCP setup to connection configuration and SHALL direct users to Settings → MCP servers for individual tool review and assistant assignment. Onboarding connection, scanning, refresh, skip, and completion SHALL NOT introduce new tool grants or a wildcard server grant. Existing definition-bound authorization and changed-definition invalidation SHALL remain effective. Setup SHALL use discovery only, without invoking a tool as a connection test or replaying an uncertain external action.

#### Scenario: Connect without granting tools
- **WHEN** a user connects a new server during onboarding
- **THEN** the server is saved without new global or assistant tool grants
- **AND** onboarding identifies Settings → MCP servers as the place to configure tool access

#### Scenario: Existing tool definition changes
- **WHEN** explicit connection discovery or refresh identifies a changed previously authorized tool definition
- **THEN** existing changed-definition invalidation applies
- **AND** renewed authorization happens through Settings rather than automatically during onboarding

#### Scenario: Resume a pending connection
- **WHEN** onboarding resumes after interruption during MCP connection configuration
- **THEN** it loads saved inventory without launching a server or submitting a draft
- **AND** connection retry requires a fresh user action

### Requirement: Completion and accessible navigation
Completion SHALL summarize actual saved setup, including MCP connection status and the route to tool permissions in Settings, and identify skipped or incomplete optional capabilities. A configured MCP server without tool access SHALL NOT be described as available to an assistant. **Open Forage** SHALL persist completion and reveal the normal workspace with the existing note and results. Completed or explicitly skipped setup SHALL NOT reopen automatically. Editing, forms, errors, and navigation SHALL remain usable by keyboard and at supported narrow window sizes.

#### Scenario: Finish setup
- **WHEN** a user chooses Open Forage
- **THEN** onboarding completion is persisted and the normal workspace opens with their note available
- **AND** the next launch does not show onboarding automatically

#### Scenario: Finish using only the keyboard
- **WHEN** a user navigates onboarding using the keyboard
- **THEN** editing, provider setup, extension selection, MCP connection configuration, skip, and completion actions are reachable with visible focus
- **AND** Enter submits only the action appropriate to the focused editor or form without duplicate execution
