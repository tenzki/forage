## Context

See proposal.md for motivation. Forage embeds Pi 0.84.2, whose `customTools` API accepts arbitrary tool definitions but provides no built-in MCP client. Local extensions have a static manifest contract; using one generic MCP call tool would obscure per-tool authorization. Server admission and local admission already intersect global, agent, and executor tool allowlists.

## Goals / Non-Goals

**Goals:** One shared MCP implementation for desktop and backend execution; arbitrary user-supplied server configurations; individual tool authorization; environment-owned connections; explicit failures and bounded cleanup.

**Non-Goals:** Exposing Forage as an MCP server, an MCP marketplace, MCP resources/prompts/apps, installing language runtimes, and interactive OAuth in this first change. Remote connections initially accept configured HTTP headers; OAuth-only services require a separately authenticated bridge. Document these compatibility limits rather than claiming all MCP features.

## Decisions

### Shared Node MCP host and generic contracts

Add `@forage/mcp-host` using the official TypeScript SDK. Browser-safe schemas live in `@forage/agent-runtime`. Discovery returns validated bounded input schemas and deterministic namespaced tool IDs. The host creates runtime tools carrying their input schemas; Pi receives those schemas through its existing custom-tool adapter. No per-server code or Forage manifest is necessary. Reject duplicate names, oversized schemas and external schema references.

### Connection ownership

Desktop Settings offers a server-name form with URL/token or launch-command fields, optional headers/environment variables, and advanced `mcpServers` JSON import. Launch commands are split into literal executable/arguments without shell evaluation. Settings and the agent tool picker resolve the persisted storage mode used by skill execution, then automatically load only that environment's inventory; they do not expose a separate location selector or fall back to local connections on backend failure. Explicit connection testing may launch user-provided commands, including package runners such as npx/uvx; describe that trusted-code action in the form. The user supplies installed runtimes. Configuration stays device-local, with sensitive configuration stored in the existing native credential vault and only identity, enablement, and discovered non-secret metadata in plugin-store. A credential-free management process performs discovery. Execution credentials reach the run sidecar only over stdin.

Backend operators provision a JSON configuration file through `FORAGE_MCP_CONFIG`, with credentials supplied by explicit environment substitutions. This avoids granting remote API callers permission to execute arbitrary backend commands. Discover at startup and expose sanitized inventory through an authenticated outline endpoint; Settings can load and assign these tools. Changes require a backend restart. Commands execute on the backend host, never on a connected desktop. No desktop configuration or secret is uploaded.

### Discovering existing client configuration

In local mode, the credential-free management sidecar reads bounded, known user-level configuration files for Codex, Claude Desktop, Claude Code, Cursor, and VS Code. TOML and JSON-with-comments parsing preserve supported connection semantics. This reads configuration without launching any MCP command. Candidate metadata excludes executable arguments and credential values. Exact definitions are deduplicated across sources; unsupported fields and missing credentials are surfaced rather than discarded. No project trees, client OAuth stores, or third-party configuration files are modified.

Candidate IDs bind the source definition and resolved configuration. Connect re-reads the source and rejects stale IDs, resolves specifically requested missing values, and passes the selected configuration through the existing local discovery/vault path. Imported metadata records the discovery ID to prevent repeat imports. Other clients remain independent; later source updates require a fresh import. Tool review and agent selection follow connection in the same Settings flow, with an explicit save that enables selected tools and adds them to chosen agents. Desktop discovery never runs in backend mode. Registry browsing, install links, bundles, and interactive OAuth remain future work.

### Admission and inventory stability

Tool permission IDs include a digest of the connection ID, exact remote tool name, definition fingerprint, and command/endpoint binding, obeying the existing 64-character limit. Identical definitions keep stable IDs; changed definitions receive new IDs and therefore require renewed authorization even across backend restarts. Local and backend IDs use separate namespaces to avoid accidentally authorizing a different environment's connection. Discovery does not enable tools. A run carries the selected tool inventory; connecting for execution verifies that inventory before exposing tools. New tools are never inserted into an active run. Remove/disable retains portable references as unavailable.

### Lifecycle and results

Connect only servers with authorized tools, retain clients for the run, and close them in `finally` after success, failure, or cancellation. Discovery and calls have deadlines; process stdout remains MCP-owned, stderr is bounded and never forwarded unsanitized. Child environments contain only essential runtime variables plus explicitly configured values, never inherited model credentials. Remote requests do not forward credentials across redirects. HTTP loopback is permitted only when explicitly configured; remote endpoints require HTTPS. Text and structured results are bounded and treated as untrusted; unsupported binary/resource content is reported clearly. Preserve tool failure status. Do not grant sampling or other server-initiated capabilities.

### Retry policy

MCP tools may mutate external systems. Do not automatically retry an MCP call after a transport error. Backend runs containing MCP tools are admitted with one attempt so worker failure, provider failure, or lease recovery cannot replay external writes. Local empty-response retry must likewise be disabled for MCP-enabled turns. Users can explicitly retry with awareness that effects may already have occurred.

## Risks / Trade-offs

- [Arbitrary local commands are trusted code] → Explicit connect action and explanation; minimal child environment; no sandbox claim.
- [Servers change tools] → Compare inventories at discovery refresh and execution; fail changed tools closed.
- [External actions complete before cancellation or failure] → No automatic replay for MCP-enabled turns; document uncertain outcomes.
- [Remote authentication diversity] → State header-auth compatibility and OAuth limitation in UI and docs.
- [Many discovered tools overflow model or current policy bounds] → Bounded discovery and at most the existing 64 authorized tools per agent; discovery alone never sends all tools to the model.
- [Backend startup dependency availability] → Preserve per-connection diagnostics; unrelated agents remain usable if a server cannot connect.

## Migration Plan

No existing configuration changes meaning. Missing MCP settings means no connections. Add shared host, desktop discovery and execution, then backend provisioning and inventory. Verify with a fixture MCP server over stdio and HTTP, plus mocked Pi turns. Removing MCP configuration makes its tool references unavailable and leaves outline content intact.
