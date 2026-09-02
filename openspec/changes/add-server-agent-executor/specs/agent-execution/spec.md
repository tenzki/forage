## ADDED Requirements

### Requirement: Execution follows storage authority
The system SHALL execute manual agent runs locally in local storage mode and on the authoritative server in server storage mode. It SHALL use the same validated run, agent, skill, tool, activity, and structured-output contracts in both environments and SHALL NOT silently fall back to a different executor.

#### Scenario: Invoke a local skill
- **WHEN** a user invokes a configured skill while the outline uses local storage
- **THEN** the local executor runs it without requiring a server and persists its run lifecycle locally

#### Scenario: Server is unavailable for a server-mode run
- **WHEN** a user invokes a skill in server mode while the configured server cannot admit it
- **THEN** the desktop reports server unavailability and does not execute the skill locally

### Requirement: Durable terminal run lifecycle
Every admitted run SHALL have a stable ID, immutable input and resolved-definition snapshot, ordered activity records, attempt records, and exactly one current status from `queued`, `running`, `retry_wait`, `completed`, `failed`, `cancelled`, or `interrupted`. Every accepted run SHALL eventually reach a terminal status when an executor is available.

#### Scenario: Recover an expired server lease
- **WHEN** a worker stops after claiming a run and its lease expires
- **THEN** another worker reclaims the run when attempts remain or marks it failed after the attempt limit

#### Scenario: Restart during local execution
- **WHEN** the desktop restarts with a locally persisted non-terminal run
- **THEN** it marks the run interrupted and preserves its activity history without committing partial outline content

### Requirement: Immutable admission snapshot
Run admission SHALL snapshot the source, prompt/context, target, outline revision, configuration revision, resolved agent and skill definitions, effective tool IDs, and credential reference. Later edits to configuration or source content SHALL NOT mutate the admitted run.

#### Scenario: Edit a skill after admission
- **WHEN** a queued run pins a skill definition and the owner later publishes a new definition revision
- **THEN** the queued run uses its original snapshot and a newly admitted run uses the new revision

### Requirement: Bounded and authorized tools
The executor SHALL expose only tools supported by the active environment and allowed by the agent, skill, global configuration, and run policy. It SHALL reject a run before model invocation when a required tool is unavailable and SHALL NOT expose a general shell, unrestricted filesystem, or arbitrary authenticated HTTP tool.

#### Scenario: Skill requires an unavailable transcript tool
- **WHEN** a skill requiring `youtube_transcript` is admitted on an executor without a configured transcript provider
- **THEN** admission fails with a structured unsupported-or-unconfigured-tool error and no model call occurs

#### Scenario: Model asks for an unauthorized tool
- **WHEN** a model emits a tool call outside the effective tool set
- **THEN** the runtime returns a bounded tool error and performs no requested action

### Requirement: Executor-owned provider credentials
Model and provider credentials SHALL be stored and refreshed by the active executor. Runs and configuration SHALL contain only credential references, and secrets SHALL NOT enter model context, outline events, activity payloads, API responses after enrollment, or logs.

#### Scenario: Refresh server ChatGPT authentication
- **WHEN** a server run references a valid ChatGPT-managed Codex credential nearing expiry
- **THEN** the server refreshes it under concurrency control, stores any rotated refresh token encrypted, and runs with the refreshed account identity

#### Scenario: Use an OpenAI API key
- **WHEN** a run references a valid server-held OpenAI API-key credential
- **THEN** the executor uses the OpenAI provider without copying the key into the run snapshot or activity history

#### Scenario: Refresh is revoked
- **WHEN** ChatGPT refresh returns an authentication-revoked result
- **THEN** the credential becomes authentication-required and new or retrying runs fail safely until the owner reconnects it

### Requirement: Encrypted credential enrollment and disconnection
A trusted local or self-hosted executor SHALL support explicit ChatGPT device authorization and API-key enrollment. Server-held secrets SHALL use authenticated encryption with key material stored outside PostgreSQL, and an owner SHALL be able to disconnect a credential.

#### Scenario: Complete headless device authorization
- **WHEN** the owner starts ChatGPT connection on a trusted server and completes the displayed browser verification
- **THEN** the server stores the resulting access, refresh, expiry, and account identity encrypted and exposes only sanitized credential metadata

#### Scenario: Disconnect a credential
- **WHEN** the owner disconnects a credential used by queued runs
- **THEN** future resolution of that credential fails without revealing or retaining it in job payloads

### Requirement: Durable cancellation and retry
Cancellation SHALL be idempotent, SHALL abort queued work immediately, SHALL signal running model and tool calls, and SHALL be rechecked before result commit. Automatic retry SHALL be bounded to classified transient failures; user retry SHALL create a linked new run rather than rewrite history.

#### Scenario: Cancel during a tool call
- **WHEN** cancellation is accepted while a source tool is running
- **THEN** the executor aborts the tool, records a terminal cancelled state, and commits no later result

#### Scenario: Retry a failed run after configuration changes
- **WHEN** the owner retries a failed run after publishing corrected configuration
- **THEN** the system creates a new linked run with the current configuration snapshot and retains the failed run unchanged

### Requirement: Exactly-once structured result commit
The runtime SHALL validate a bounded structured result before any outline mutation. A successful server run SHALL commit its result events, terminal run provenance, projection updates, unique result record, and terminal status atomically so retries or lease recovery cannot duplicate output.

#### Scenario: Completion transaction is retried
- **WHEN** a worker repeats completion after an ambiguous database response
- **THEN** the unique result identity returns the original committed revisions and no duplicate result nodes are added

#### Scenario: Target is no longer live
- **WHEN** a run finishes after its stable target note was trashed or purged
- **THEN** the run terminates with `target_unavailable`, does not resurrect the target, and appends no outline result

### Requirement: Observable run APIs and local parity
Authorized clients SHALL be able to invoke, list, inspect, cursor-poll activity, cancel, and retry runs within their bound outline. The local executor SHALL provide equivalent behavior through its local adapter. Raw reasoning, provider secrets, and unbounded fetched bodies SHALL NOT be exposed.

#### Scenario: Poll activity after reconnecting
- **WHEN** a client requests activity after its last observed sequence for an existing run
- **THEN** it receives the next bounded ordered page and the current run status without duplicate sequence entries

#### Scenario: External capture token reads runs
- **WHEN** a credential with only `notes:create` requests run details
- **THEN** the server denies access without revealing whether the run exists
