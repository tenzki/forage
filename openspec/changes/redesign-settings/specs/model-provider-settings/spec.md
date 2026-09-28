## Purpose

Allow several model-provider connections while resolving one explicit default provider, model, and credential in the environment executing agents.

## ADDED Requirements

### Requirement: Connected accounts and standard provider selection
Connection SHALL list configured provider accounts with sanitized status and management actions. An Add provider action with a plus icon SHALL open a standard dropdown and the selected provider's supported authentication controls. The initial supported choices SHALL include Anthropic, OpenRouter, OpenCode Go, OpenAI API access, and ChatGPT subscription access. Disconnected catalog entries SHALL NOT each occupy an account row before setup.

#### Scenario: Add another provider
- **WHEN** a user chooses Add provider and selects an API-key provider
- **THEN** its credential form is shown below the dropdown
- **AND** successful setup adds the account to the connected-account list without silently changing the default model

#### Scenario: Existing ChatGPT connection
- **WHEN** a user manages ChatGPT subscription access
- **THEN** the existing supported sign-in and reauthorization flow remains available
- **AND** subscription access is not treated as a generic API key

#### Scenario: Connection validation fails
- **WHEN** provider authentication or connectivity cannot be verified
- **THEN** setup reports an actionable sanitized error and does not claim the account is ready
- **AND** canceling leaves the current account and compute selection unchanged

### Requirement: Explicit default provider and model
Connection SHALL offer separate default-provider and model selectors using the current execution environment's connected accounts and supported model catalog. Saving a selection SHALL validate the provider/model/credential combination as a unit. Agents SHALL inherit that environment default without portable per-agent model or credential fields.

#### Scenario: Change the default
- **WHEN** a user selects a connected provider and a supported model
- **THEN** subsequently admitted runs use that compute selection
- **AND** existing admitted runs retain their snapshots and agent definitions are not rewritten

#### Scenario: Selected provider becomes unavailable
- **WHEN** the selected credential is revoked or its model becomes unavailable
- **THEN** Forage retains enough selection metadata to explain and repair the problem
- **AND** no other provider, credential, model, or execution environment is silently substituted

### Requirement: Environment-owned provider credentials
Local accounts and secrets SHALL remain under device credential authority. Server-mode account and compute edits SHALL use authenticated server authority and server-owned credentials. Provider setup SHALL state where the account will be used without adding an independent location selector. Switching workspace mode SHALL retain separate local and server selections and SHALL NOT transfer credentials implicitly.

#### Scenario: Add an account in server mode
- **WHEN** a connected user explicitly submits server provider setup
- **THEN** the server stores the credential through its protected credential service and returns sanitized metadata
- **AND** provider credentials are absent from portable agent configuration, outline events, activity, and diagnostic reports

#### Scenario: Return to local mode
- **WHEN** the workspace disconnects from the server
- **THEN** locally retained accounts and compute selection become applicable again
- **AND** server-only secrets do not become desktop credentials

#### Scenario: Older server lacks a provider
- **WHEN** the connected server cannot support a provider or model requested by the desktop
- **THEN** the UI identifies that limitation and refuses the unsupported save without changing the active profile

### Requirement: Existing-account migration
Upgrading SHALL preserve existing OpenAI and ChatGPT credential identities, selected authentication mode, selected model, and local/server separation. Migration SHALL be repeatable and SHALL NOT expose secret material in general settings storage.

#### Scenario: Upgrade an existing installation
- **WHEN** an installation with valid legacy model settings first opens the redesigned Settings
- **THEN** its current account and model remain selected and usable without re-entering credentials
- **AND** repeating migration does not duplicate accounts or reset the selection
