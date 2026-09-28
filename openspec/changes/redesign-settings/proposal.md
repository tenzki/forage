## Why

Settings mixes everyday preferences, provider credentials, agent permissions, extension internals, and runtime diagnostics. The approved `docs/desktop.pen` redesign makes these responsibilities easier to find and supports multiple model providers without turning Connection into a growing catalog of disconnected accounts.

## What Changes

- Make General the initial section, followed by Connection, Agents, Extensions, and MCP servers. Add persistent appearance preferences, an outline preview, actual application version, and a nested Diagnostics page; remove top-level Advanced.
- List connected provider accounts and add a standard dropdown-based Add provider flow. Support Anthropic, OpenRouter, OpenCode Go, and existing OpenAI API/ChatGPT authentication, with separate environment-default provider/model selection.
- Add a dedicated agent editor with built-in and extension tools in one list, source labels, and per-MCP-server tool selection. Remove the extra MCP master toggle and separate Extensions selector.
- Move extension tool policy to consistent extension detail pages. Offer explicit Create skill actions for extension executors; extensions never install skills themselves. Remove the extension Copy report action while retaining bounded inspectable errors.
- Separate connected MCP servers from detected candidates. Use one Add server flow for URL, command, and optional JSON setup; make tool summaries expandable and move Refresh tools to the top of server details.
- Move server status/recovery into Connection and runtime diagnostics under General. Retain Inbox rules and existing server provisioning safeguards.
- Preserve execution authority, credential boundaries, existing tool permissions, and legacy account selections during migration.

## Capabilities

### New Capabilities

- `settings-navigation`: Settings sections, nested editing flows, server recovery, and diagnostics placement.
- `general-preferences`: Device-local appearance preferences, preview, reduced-motion handling, and application version.
- `model-provider-settings`: Multiple connected providers, account setup, and environment-owned default compute selection.
- `agent-settings`: Dedicated editing, unified tool provenance, and per-server MCP access without a master permission switch.
- `mcp-settings`: Connected/detected inventory presentation, manual setup navigation, and compact permission review over the existing MCP client.

### Modified Capabilities

- `local-agent-extensions`: Consistent detail pages, extension-owned global tool policy, a unified per-agent tool list with source labels, and explicit user-created skill setup.

## Impact

- Desktop Settings components, settings persistence, theme/editor presentation, native credential commands, and application-version access.
- Shared provider/credential/compute contracts, Pi authentication adapters, local admission, server credential/profile APIs and persistence, and server admission.
- Existing MCP and extension management services are reused. This change depends on the behavior in `add-mcp-client` and generic executors in `add-system-one-skills`; it does not duplicate or replace those active changes.
- Provider and preference migrations, focused UI/runtime/contract tests, native desktop verification, and settings documentation.
- No document-event migration, per-agent model override, backend MCP configuration editor, automatic skill installation, or new result-placement workflow. See `design.md` for explicit differences between illustrative mockups and implementation scope.
