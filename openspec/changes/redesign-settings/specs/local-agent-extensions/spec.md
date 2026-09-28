## MODIFIED Requirements

### Requirement: First-class Extensions settings
Settings SHALL include an Extensions view listing discovered and installed sources with identity, version/revision, source kind, status, contribution counts, and bounded diagnostics. It SHALL provide Install, Open folder, Refresh, Review, Details, and applicable lifecycle actions. Sources needing review or attention SHALL produce a non-blocking count indicator and SHALL NOT open an unsolicited startup dialog. Extension detail pages SHALL share an identity/status header and Configuration, Tools, Use in a skill, and expandable Extension details sections, with honest empty states for absent contributions. Extension pages SHALL NOT include a Copy report action; bounded diagnostic text SHALL remain inspectable and copyable.

#### Scenario: Inspect an extension before enabling it
- **WHEN** a user opens Details for an untrusted source
- **THEN** the app shows manifest metadata, declared tools/hooks/settings, source, compatibility, and the trusted-code warning without executing the entry

#### Scenario: Extension validation fails
- **WHEN** a trusted source throws while its entry is validated
- **THEN** the list and detail view show Error with a bounded copyable diagnostic and the rest of Settings remains usable

#### Scenario: Compare different extension types
- **WHEN** a user inspects System One and Text Stats
- **THEN** both use the same detail hierarchy and lifecycle action placement
- **AND** required configuration, available tools, and skill actions reflect each manifest rather than hard-coded extension-specific layouts

### Requirement: Dynamic catalog and retained configuration
Forage SHALL display validated extension tools with source identity. Global extension-tool enablement SHALL be managed from the corresponding extension detail page, and per-agent extension tools SHALL appear in the ordinary tool list with source labels rather than a separate Extensions selector. Loading or saving configuration SHALL retain syntactically valid references to missing, disabled, incompatible, or erroneous tools and show their reason. New extension tools SHALL require separate global enablement and agent selection.

#### Scenario: A configured extension is temporarily missing
- **WHEN** a previously selected tool's source cannot be loaded
- **THEN** its selection remains stored and is shown as unavailable
- **AND** restoring the same source makes it usable only when current policy permits it

#### Scenario: Enable an extension
- **WHEN** an extension becomes Ready
- **THEN** none of its tools are automatically globally enabled or added to an agent
- **AND** its detail view offers global tool enablement and explicit agent selection

#### Scenario: Move Text statistics settings
- **WHEN** the redesigned Settings loads existing Text statistics permissions
- **THEN** global settings appear on Text Stats details and agent permissions appear in each ordinary agent tool list
- **AND** relocation does not change existing authorization

## ADDED Requirements

### Requirement: Explicit skill creation from extension details
An extension with a declared generic executor SHALL offer Use in a skill with an explicit Create skill action. This action SHALL open an application-owned user skill draft with the executor selected, requiring the user to choose a valid slash label and configuration and save it. Extensions SHALL NOT create or install skills automatically, and the detail page SHALL NOT present an executor as an automatically installed slash command.

#### Scenario: Create a skill using an extension
- **WHEN** a user chooses Create skill for an extension action
- **THEN** the standard skill editor opens with that action selected
- **AND** no skill exists until the user saves a valid draft

#### Scenario: Cancel or incomplete setup
- **WHEN** the user cancels the draft or required extension configuration is unavailable
- **THEN** canceling creates no command and unavailable setup is explained before a skill can run
- **AND** extension installation or enablement alone does not create a skill
