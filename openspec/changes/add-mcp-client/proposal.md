## Why

Users should be able to connect their own MCP servers and use discovered tools from Forage agents without a preset integration or a Forage extension. Both desktop and backend agents need this capability, with connections and credentials owned by the environment doing the work.

## What Changes

- Add generic MCP connections for local stdio commands and remote Streamable HTTP endpoints, with dynamic tool discovery and no provider catalog requirement.
- Add connection management, connection testing, inventory refresh, and tool selection in desktop Settings, including visibility into backend MCP tools.
- Bridge discovered schemas and tool calls into Pi's custom-tool API through a shared Node MCP host.
- Keep individual MCP tools subject to global and per-agent authorization, preserve stable connection/tool identities, and reject changed run inventories.
- Store connection configuration and credentials under local or backend authority; never synchronize executable commands or secrets with portable agent configuration.
- Bound discovery, requests, results, and cleanup. Do not silently retry external mutations.

## Capabilities

### New Capabilities

- `mcp-client`: User-configured MCP connections, discovery, authorization, and execution for desktop and backend agents.

### Modified Capabilities

None. Existing extension contracts remain unchanged.

## Impact

- Shared MCP contracts and Node host, the official MCP TypeScript SDK, desktop Settings and agent admission, sidecar lifecycle and packaging.
- Backend connection configuration, tool admission, worker execution, and authenticated inventory access.
- Focused protocol, authorization, lifecycle, UI, and backend tests, plus architecture and setup documentation.
