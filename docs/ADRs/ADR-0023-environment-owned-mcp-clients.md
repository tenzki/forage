# ADR-0023: Connect User-Configured MCP Servers Through Environment-Owned Clients

- **Status:** Accepted
- **Date:** 2026-09-27
- **Deciders:** Forage maintainers
- **Supersedes:** ADR-0007 only for explicitly configured MCP endpoints and commands

## Context

Users need tools from arbitrary MCP servers without provider-specific Forage code. Pi exposes custom tools but does not own MCP connections. The Forage extension API deliberately requires a static manifest, while MCP discovers tools by connecting to an executable or HTTP endpoint. A single generic forwarding tool would conceal individual tool permissions.

## Decision

Use an application-owned MCP provider implemented by a shared Node host. Discover tool definitions through the official MCP SDK and adapt selected tools to Pi's custom-tool API. Preserve schema validation, global/per-agent authorization, activity, bounded output, cancellation, and ordinary outline placement.

Desktop connections are explicitly configured and started by the user. Backend connections are provisioned by the operator through `FORAGE_MCP_CONFIG`; an authenticated read endpoint exposes metadata only. Local configuration lives in the native credential vault. Backend credentials come from the backend environment or operator-owned configuration. Portable agent configuration contains tool IDs, never executable settings or credentials. No server execution falls back to a desktop process.

Permission IDs bind environment, connection identity, exact remote name, command/endpoint binding, and tool definition. Identical definitions retain IDs; changed definitions require renewed authorization. Runs snapshot admitted definitions and verify them at execution. Discovery and connection enablement do not authorize tools.

Explicit commands are trusted code with the host user's permissions, not sandboxed integrations. HTTP endpoints are explicitly configured, use HTTPS except for loopback, and cannot redirect configured credentials. Child processes receive a minimal environment, and configured secrets are removed from returned text and diagnostics.

MCP-enabled turns disable automatic provider/empty-response retries. Backend admission gives them one attempt, including lease recovery, because repeating a turn can duplicate external mutations. This sacrifices automatic recovery where external effects cannot be established safely.

## Alternatives

- Per-provider Forage extensions require custom integration work and static declarations; they do not meet arbitrary-server support.
- One generic MCP tool weakens per-tool visibility and selection.
- Loading third-party Pi MCP extensions would expose an internal engine's packaging and lifecycle conventions as the Forage contract.

## Consequences

One implementation supports desktop and backend execution, but Forage owns connection lifecycle, discovery bounds, inventory stability, and configuration UX. Header authentication and text/JSON tools are supported initially; interactive OAuth and other MCP capabilities remain separate work. Protocol support uses a pinned SDK rather than hand-written MCP transport code.

See [MCP setup](../mcp.md) and [the OpenSpec change](../../openspec/changes/add-mcp-client/design.md).
