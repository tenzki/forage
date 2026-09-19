## Purpose

Let users extend local Forage agents through a trusted Forage-native API while keeping discovery, configuration, application surfacing, tool authorization, and execution location explicit.

## ADDED Requirements

### Requirement: Explicit extension discovery and trust
Forage SHALL inventory extension directories under `~/.forage/extensions/`, explicitly registered local directories, and managed packages by reading `forage.extension.json` without importing executable code. It SHALL require explicit trust and enablement before loading an entry and SHALL NOT discover extensions from the process working directory, ancestor directories, ambient `.forage` folders, or Pi configuration.

#### Scenario: Drop in a new extension
- **WHEN** a user places a manifest-bearing `weather-tools` directory under `~/.forage/extensions/` and refreshes Extensions settings
- **THEN** Forage lists its declared identity and contributions as Needs review
- **AND** its entry is not imported until the user trusts and enables that source

#### Scenario: Launch from a repository containing extensions
- **WHEN** Forage starts with a working directory containing `.pi/extensions` or `.forage/extensions`
- **THEN** those directories contribute no code, tools, instructions, or skills unless explicitly registered

### Requirement: Native extension host API
Forage SHALL load supported entry modules through the versioned `@forage/extension-api` contract and adapt their registered tools and hooks to the local agent engine. It SHALL NOT expose Pi APIs, claim Pi compatibility, or load Pi manifests by convention. V1 SHALL support tool registration, bounded results/progress/logging, declared configuration access, cancellation, and documented `run:start` and `run:end` hooks.

#### Scenario: Register a native tool and hook
- **WHEN** an enabled extension uses `defineExtension` to register a declared tool and `run:start` handler
- **THEN** the tool appears in the validated catalog and the handler executes for an admitted local run before the model starts

#### Scenario: Extension imports Pi APIs
- **WHEN** an extension expects Pi's host object or package conventions instead of the Forage API
- **THEN** validation fails with an incompatible-extension diagnostic rather than providing a partial Pi environment

### Requirement: Manifest and runtime agreement
Forage SHALL validate that runtime tool IDs and hooks exactly match the extension's static declarations. A missing or undeclared contribution SHALL fail source validation closed, and incompatible API or manifest versions SHALL remain inspectable but unavailable.

#### Scenario: Entry registers an undeclared tool
- **WHEN** an extension manifest declares `weather_lookup` but its entry also registers `run_shell`
- **THEN** validation rejects `run_shell` and marks the source erroneous without adding either tool to an agent

#### Scenario: Future API version is installed
- **WHEN** an extension requires an API version newer than the host supports
- **THEN** Extensions settings shows its manifest and Incompatible status without importing its entry

### Requirement: First-class Extensions settings
Settings SHALL include an Extensions view listing discovered and installed sources with identity, version/revision, source kind, status, contribution counts, and bounded diagnostics. It SHALL provide Install, Open folder, Refresh, Review, Details, and applicable lifecycle actions. Sources needing review or attention SHALL produce a non-blocking count indicator and SHALL NOT open an unsolicited startup dialog.

#### Scenario: Inspect an extension before enabling it
- **WHEN** a user opens Details for an untrusted source
- **THEN** the app shows manifest metadata, declared tools/hooks/settings, source, compatibility, and the trusted-code warning without executing the entry

#### Scenario: Extension validation fails
- **WHEN** a trusted source throws while its entry is validated
- **THEN** the list and detail view show Error with a bounded copyable diagnostic and the rest of Settings remains usable

### Requirement: Bounded app-rendered configuration
Forage SHALL render manifest-declared string, multiline string, number, boolean, fixed-choice, and secret settings using application-owned controls. Extensions SHALL NOT provide executable Settings UI. Missing required configuration SHALL produce Needs configuration and prevent the extension from being admitted to a run.

#### Scenario: Configure an API-backed extension
- **WHEN** an extension declares a required secret token and a non-secret fixed-choice region
- **THEN** Details renders both fields, stores them through their correct device-local boundaries, and reports Ready only after valid values are saved

#### Scenario: Extension requests custom UI
- **WHEN** a manifest or entry attempts to contribute a React component, HTML settings panel, navigation item, or editor command
- **THEN** Forage rejects the unsupported contribution and does not render extension code in the webview

### Requirement: Dynamic catalog and retained configuration
Forage SHALL display validated extension tools in global and per-agent selectors grouped by source. Loading or saving configuration SHALL retain syntactically valid references to missing, disabled, incompatible, or erroneous tools and show their reason. New extension tools SHALL require separate global enablement and agent selection.

#### Scenario: A configured extension is temporarily missing
- **WHEN** a previously selected tool's source cannot be loaded
- **THEN** its selection remains stored and is shown as unavailable
- **AND** restoring the same source makes it usable only when current policy permits it

#### Scenario: Enable an extension
- **WHEN** an extension becomes Ready
- **THEN** none of its tools are automatically globally enabled or added to an agent
- **AND** its detail view offers navigation to the tool-policy surface

### Requirement: Effective tool authorization
Forage SHALL expose to the model only tools in the intersection of current executor capabilities, global enablement, agent selection, and run policy, plus the application-owned structured-output tool. Required skill tools SHALL be checked before model invocation. These rules SHALL apply equally to built-in, custom HTTP, and extension tools, and unauthorized calls SHALL perform no tool action.

#### Scenario: Disable a built-in or extension tool
- **WHEN** a tool is globally disabled or omitted from the selected agent
- **THEN** it is absent from model-visible definitions and cannot execute through the model tool dispatcher

#### Scenario: Required tool is unavailable
- **WHEN** a selected skill requires a missing, incompatible, disabled, conflicting, or unconfigured extension tool
- **THEN** admission fails with an actionable unavailable-tool error before any model call

### Requirement: Stable tool identity and collision handling
Forage SHALL use valid manifest-declared tool IDs as portable IDs and associate them with supplying extension and installation identities. It SHALL prevent extensions from replacing application-owned or custom HTTP tools. If two enabled extensions provide the same tool ID, both conflicting contributions SHALL be unavailable with diagnostics identifying their sources.

#### Scenario: Override the output tool
- **WHEN** an extension declares or registers `emit_outline` or another reserved name
- **THEN** Forage rejects the contribution and retains the application implementation

#### Scenario: Duplicate extension tool IDs
- **WHEN** two enabled sources register the same tool ID
- **THEN** neither contribution is selectable until the conflict is resolved and load order does not choose a winner

### Requirement: Honest local-code trust boundary
Before first source activation, Forage SHALL explain that enabled extension code can access local files, network resources, process resources, and values available to its run process with the user's permissions. The UI SHALL distinguish installation, source enablement, extension configuration, and model tool authorization and SHALL NOT present the process boundary, manifest, or tool toggles as a sandbox.

#### Scenario: Disable a tool while its extension remains enabled
- **WHEN** a user disables one tool contributed by an enabled extension
- **THEN** the model cannot call that tool
- **AND** Settings explains that source initialization and declared lifecycle hooks can still execute

### Requirement: Reload and run consistency
Forage SHALL apply reloads and catalog/configuration changes to subsequently admitted runs, retain an identifiable source and configuration revision for each admitted local run, and SHALL NOT replace implementations during an active run. If the admitted revision cannot be loaded, the run SHALL fail before model invocation instead of silently executing different code.

#### Scenario: Reload during an active run
- **WHEN** a user edits a trusted local extension and reloads while a run uses its previous revision
- **THEN** the active run retains its loaded implementation and new runs use the refreshed catalog

#### Scenario: Source changes after admission
- **WHEN** an admitted run has not started and its source digest differs from the admitted revision
- **THEN** it fails before model invocation and the user can retry against the current catalog

### Requirement: Observable bounded execution
Forage SHALL show bounded extension tool activity with extension provenance, propagate cancellation, and terminate an unresponsive validation or run process after a bounded grace period. Extension logging SHALL NOT corrupt the structured host stream. Results SHALL pass existing validation and document-commit paths; extensions SHALL NOT mutate the outline directly.

#### Scenario: Extension tool logs and throws
- **WHEN** a tool logs a message and then throws
- **THEN** the host remains able to parse its protocol and displays a bounded failure with extension provenance without committing invalid output

#### Scenario: Extension ignores cancellation
- **WHEN** a running extension fails to stop within the cancellation grace period
- **THEN** Forage terminates that run process and accepts no late result

### Requirement: Local extensions respect execution authority
Extension code, installations, paths, trust, settings, secrets, and local run snapshots SHALL remain device-local. Portable configuration SHALL carry only valid tool references, not installation authority. Server-mode invocations SHALL use the server executor and SHALL NOT fall back to local execution to satisfy an extension dependency.

#### Scenario: Server-mode skill requires a local extension
- **WHEN** a skill requires a tool installed only on the desktop and is invoked in server mode
- **THEN** admission reports the unavailable server capability without running the desktop extension

#### Scenario: Receive an unknown tool through configuration synchronization
- **WHEN** synchronized configuration references a tool not installed locally
- **THEN** Forage preserves the reference as unavailable and does not fetch, install, trust, configure, or execute a package
