## Purpose

Guarantee that a skill run behaves the same whether it executes locally or on the server, by using one agent loop with shared prompt rules, tool policy, limits, source verification and outcomes.

## ADDED Requirements

### Requirement: One agent loop in both environments
Local and server execution SHALL use the same agent loop and the same session setup. For the same agent, skill, effective tools, context and prompt, both environments SHALL compose the same system prompt and first message, expose the same effective tool set, and apply the same limits and result validation. Environment differences SHALL be limited to credentials and model runtime, environment-specific tool implementations, image asset handling and conversation storage.

#### Scenario: Same skill in both modes
- **WHEN** a user runs the same skill on equivalent outlines once in local mode and once in server mode
- **THEN** both runs receive the same instructions, tool list and context layout

#### Scenario: Required tool unavailable in one environment
- **WHEN** a skill requires a tool that the executing environment does not provide
- **THEN** the run is rejected before any model call with the unsupported-tool error, in either environment

### Requirement: Untrusted material and verified citations
In both environments, fetched and captured source material SHALL be presented to the model as untrusted data, never as instructions. A result's sources SHALL include only URLs returned by successful source-reading tool calls in the same run; other cited URLs SHALL be dropped from the result's sources.

#### Scenario: Model cites a search-result link it never read
- **WHEN** the model lists a source URL that only appeared in web search results
- **THEN** that URL is removed from the result's sources in both local and server mode

### Requirement: Bounded tool loop
Both environments SHALL stop a turn that exceeds the tool-round limit (8 by default, never more than 20) with a tool-round-limit failure. They SHALL answer tool calls beyond 16 in one model response, and calls to tools outside the effective set, with a bounded tool error instead of executing them. They SHALL bound tool output before returning it to the model.

#### Scenario: Unauthorized tool call
- **WHEN** the model calls a tool that is not in the run's effective tool set
- **THEN** the tool is not executed and the model receives "Tool is not authorized for this run."

#### Scenario: Endless tool use
- **WHEN** the model keeps calling tools past the round limit
- **THEN** the run fails with the tool-round-limit error and nothing is placed

### Requirement: Result outcomes
A first turn SHALL produce a validated structured outline result through the outline-emitting tool. In local mode, a first turn that ends with text only SHALL fall back to text bullets. In server mode it SHALL fail with the structured-result-required error, so unattended runs never place free text. A resumed conversation turn MAY end with text, which SHALL be treated as an inline answer in both environments.

#### Scenario: Server automation returns prose
- **WHEN** an Inbox automation run ends with plain text and no outline result
- **THEN** the run fails with the structured-result-required error and the outline is unchanged

### Requirement: Stable failure codes
Moving the server to the shared loop SHALL keep the existing run failure codes and retry classification (authentication required, unsupported tool, invalid output, tool round limit, provider and dependency errors), so clients and stored history keep their meaning.

#### Scenario: Expired server credential
- **WHEN** a server run's credential can no longer be resolved
- **THEN** the run fails with the authentication-required code and is not retried
