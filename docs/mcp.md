# MCP servers

Forage can connect to user-supplied MCP servers and expose their tools to agents. There is no preset provider catalog and no Forage extension to write. Both desktop and backend agents use the same MCP client and Pi tool adapter.

## Desktop setup

1. Open **Settings → MCP servers**. Forage automatically uses the same local or server mode as your agents; there is no separate MCP location selector.
2. In local mode, **Connected** lists saved connections and their access status; **Detected on this computer** lists unconnected MCP definitions from supported clients. For example, Pen registered with Codex appears with **Found in Codex** and a **Connect** button.
3. Click **Connect**. If credentials cannot be reused, enter the requested values first. Forage connects to the server and opens tool review and agent selection.
4. Explicitly choose the tools and agents, then click **Save access**. New tools start unchecked. Connecting alone does not authorize tools. **Cancel** leaves the connection saved without granting additional access; dirty review first offers Keep editing or Discard changes.

Use **Manage** on any connected server to inspect tools and edit access later. Tool switches stage global policy until Save access. Selected agents receive additions of the reviewed tool IDs only; existing agent references and other servers' global policy remain unchanged. Save without selecting agents to change global policy alone. Remove individual agent selections in the agent editor. A local save followed by failed server publication is reported separately; retrying unchanged access republishes without repeating the local save.

### What discovery reads

The scan reads only these user-level configuration sources:

| Client | Configuration |
| --- | --- |
| Codex | `~/.codex/config.toml` (`CODEX_HOME` override supported) |
| Claude Desktop | `Claude/claude_desktop_config.json` in the platform application configuration directory |
| Claude Code | Top-level `mcpServers` in `~/.claude.json` (`CLAUDE_CONFIG_DIR` override supported) |
| Cursor | `~/.cursor/mcp.json` |
| VS Code | `Code/User/mcp.json` in the platform application configuration directory |

On macOS the application configuration directory is `~/Library/Application Support`; on Windows it is `%APPDATA%`; on Linux it is `$XDG_CONFIG_HOME` or `~/.config`. JSON comments and trailing commas are supported. Project entries, plugins, profiles, and other clients' OAuth credential databases are not scanned. Each file is limited to 1 MB and the list to 100 candidates.

Scanning launches no MCP commands and returns names, sources, transport, missing credential field names and sanitized issues only. Identical definitions are combined across sources; variants with different arguments or settings stay separate, identified by source and a short definition identity. Unchanged imports already saved in Forage are omitted from Detected rather than offered again. Distinct definitions may need distinct Forage names; use Connection name before importing a same-name variant. A changed source definition requires **Scan again** before import. A missing or invalid source does not block the others or hide existing connections.

Forage copies a connection when you click Connect; it never edits the source client's configuration or follows subsequent changes automatically. Literal environment/header credentials are copied into Forage's native credential store. Explicit Codex environment references use variables available to the management process; unavailable values and client input placeholders become credential fields. Enter complete header values, such as `Bearer your-token`, when a header is requested. App-specific authentication, tool restrictions, unsupported transport types and command/URL placeholders require advanced setup. Scanning does not provide interactive OAuth.

Pen must be running with the intended document open when its tools are used. Discovery finds its registered configuration, not every installed app. Forage does not install Pen, language runtimes, or arbitrary MCP bundles. Local Pen connections cannot be imported into a remote backend.

### Add server

If the server was not found, click **Add server**, enter a **Server name** and choose **Connect using** on the dedicated setup page. Server URL is selected initially:
   - **Server URL:** enter the Streamable HTTP endpoint and choose **Browser sign-in** (default), **Manual credentials**, or **None**. Browser sign-in uses the system browser; manual credentials support a Bearer access token or a custom Authorization header, never both. None rejects Authorization headers.
   - **Launch command:** paste the server's command, such as `npx -y your-mcp-package` or `uvx your-mcp-package`. Add environment variables using the name/value fields. A working directory is optional.

Click **Connect server** to open explicit tool/agent review. Switching setup methods preserves independent drafts but never submits the other method's secrets or fields. Cancelling before connecting saves nothing. Install the runtime or executable required by your MCP server first. Forage uses the Node.js available to the desktop sidecar; Python servers may require Python and `uv`/`uvx` separately.

### Browser sign-in on this device

Choose **Sign in and connect**, complete consent in your system browser, and return to Forage. The five-minute request freezes setup fields. **Open browser again** and **Copy sign-in link** reuse the active request; **Cancel sign-in** closes it without saving a new connection. Retry starts fresh state and PKCE. Leaving setup or changing execution environment cancels pending authorization. Do not share a sign-in link; it is temporary and is not saved in settings, activity, or diagnostics.

Forage supports Authorization Code with PKCE S256 and a public native client: dynamic client registration when advertised, an explicitly supplied public client ID, or an explicitly supplied HTTPS client metadata document URL when the server supports it. Choose only one advanced registration option. Forage provides no hosted metadata document or shared/bundled client secret, and never borrows another client's registration. A provider requiring unsupported registration, a confidential client, or a different grant receives an unsupported-sign-in message; choose manual credentials yourself if the provider supports them. The exact callback is `http://127.0.0.1:<ephemeral-port>/oauth/callback`; a pre-registered native client must permit the provider-supported loopback port variation. Metadata and authorization services may legitimately have different hostnames from the MCP endpoint.

Consent connects the server but **enables no tools or agents**. Review the discovered tools and choose **Save access**. Tool selection is global policy; selected agents receive additive grants without removing unrelated existing permissions. Cancelling review retains the authenticated connection without new grants. Some tools can change external data; grant only what trusted agents need.

Forage serializes refresh and saves rotated tokens in its native SQLite credential store before releasing an access token. An omitted replacement refresh token retains the previous one. Missing/revoked refresh credentials require **Sign in again**. Your saved selections remain visible but unavailable. Every successful interactive reauthentication requires a new explicit access review, even when tool definitions are unchanged, because the browser may choose a different account or site. Changed/new tool definitions remain ungranted; silent refresh alone does not change permission IDs.

Agent runs never open a browser, receive refresh credentials, or retry an unauthorized MCP request. A 401, 403, cancelled request, or transport failure may follow a completed external mutation; inspect the external service before starting a new run. Transient refresh failures do not delete credentials or prove revocation. If a refresh exchange has an ambiguous outcome, Forage records that fact durably rather than repeating it on the next run or after restart; use explicit sign-in to recover.

Disconnect invalidates pending jobs and removes local credentials/configuration and tool enablement first. Remote revocation is bounded and best-effort when the provider advertises an endpoint; it does not log you out of browser cookies or guarantee removal of provider-side consent. The native SQLite vault is not an OS keychain or an additional encryption-at-rest guarantee.

Jira's hosted MCP endpoint (`https://mcp.atlassian.com/v2/mcp`) can be entered as an ordinary server URL; there is no Atlassian preset. Live compatibility depends on the provider's public-client registration, callback, administrator and consent policies. Real Atlassian sign-in is a pending user acceptance check, not established by fixture tests. Legacy HTTP configurations and imported static credentials remain manual/no-auth; authentication failure never silently converts them to OAuth. Other clients' OAuth caches are never imported. Backend connections remain operator-owned and do not use desktop OAuth.

If a setup guide supplies `mcpServers` JSON, use the collapsed **Import existing JSON configuration → Import and connect** disclosure in Add server. Successful imports open review for each connection in turn; cancelling leaves the remaining imports saved but unauthorized. A failed multi-server import may have saved earlier entries, which remain manageable; the error does not claim all entries connected. For example:

   ```json
   {
     "mcpServers": {
       "my-local-server": {
         "command": "node",
         "args": ["/absolute/path/to/server.mjs"],
         "env": { "SERVICE_TOKEN": "your-token" }
       },
       "my-remote-server": {
         "url": "https://your-server.example/mcp",
         "headers": { "Authorization": "Bearer your-token" }
       }
     }
   }
   ```

The launch-command field supports quoted arguments and escaped spaces. It splits the command into an executable and literal arguments without evaluating a shell; shell operators, environment assignments, and expansions are rejected. Use the environment-variable fields and absolute paths instead. In JSON, `command` is only the executable and arguments belong in the `args` array. Use an absolute executable path if the desktop cannot find a command on its PATH. Package runners may download and execute code when launched, so use a trusted source and pin package versions when reproducibility matters. Forage does not install Node/Python runtimes or provide an OS sandbox for MCP servers.

Approved tools update automatically: each run loads the current names, descriptions, and input schemas for its approved remote tool names. Definition changes do not require renewed selection. Approval means trusting future changes to that tool on the same connection; Forage cannot guarantee unchanged semantics. New tools remain disabled and are never added to an active run.

Use **Manage → Refresh tools**, beside the Tools heading, to update the Settings inventory. Existing selections are retained across description/schema changes, including legacy local permission IDs; removed tools are disabled. Tool-list, binding, availability, or signed-in-account changes can invalidate an open selection form; definition-only changes do not. Refresh alone never grants additional access. Descriptions are bounded untrusted plain text with one-line previews and independently expandable full text; expansion does not change authorization. Every server uses a neutral plug icon, without fetching server-provided logos. Disable a connection in Connection details to make its tools unavailable; Disconnect also deletes its saved configuration. To change a command, URL, or credential, disconnect and add the updated configuration.

New permission IDs bind the environment, connection, remote name, and command/endpoint rather than the mutable definition. Existing local IDs are retained on refresh. Backend operators upgrading from the former definition-hashed IDs must enable/select the newly generated backend IDs once; subsequent definition changes and backend restarts keep those IDs stable. A legacy snapshot whose redacted metadata cannot verify its original binding requires an inventory refresh, not renewed tool approval.

Configuration, including environment variables and HTTP headers, is saved in the native local credential vault. The ordinary settings file contains connection identity, enablement, and discovered tool metadata. Neither executable configuration nor secrets synchronize with agent settings.

## Backend setup

An operator configures servers on the machine running the Forage backend. Create an `mcpServers` JSON file using the same format and set `FORAGE_MCP_CONFIG` to its absolute path. Reference backend environment variables in `env` or `headers`:

```json
{
  "mcpServers": {
    "company-search": {
      "url": "https://search.example/mcp",
      "headers": { "Authorization": "Bearer ${SEARCH_TOKEN}" }
    },
    "local-index": {
      "command": "/usr/local/bin/node",
      "args": ["/opt/index-mcp/server.mjs"],
      "env": { "INDEX_TOKEN": "${INDEX_TOKEN}" }
    }
  }
}
```

Set the named secrets in the backend environment, then restart Forage. Subprocesses inherit only basic runtime environment variables plus the explicitly configured `env` values. They do not inherit database, encryption, or model credentials. Commands and paths refer to the backend host or container; install the necessary executables there.

Open **Settings → MCP servers** while Forage is in server mode. The backend inventory loads automatically, and the agent picker shows these tools. Use **Manage → Save access** to enable reviewed tools for explicitly selected agents; the normal authorized configuration publication sends tool references to the backend. Backend tools can run while every desktop is closed, including through Inbox automation. Local and backend tool IDs are distinct, so each environment needs explicit tool authorization. An unavailable backend reports an error and offers Try again instead of falling back to device-local connections. Backend connections are still added by the operator through the configuration file; device discovery, Add server, enable/disable, and Disconnect mutations are absent in server mode. No executable backend configuration or secrets are displayed or exported.

The backend reads configuration and discovers tools at startup. Restart it after changing the file or updating a server, then refresh backend tools in Settings. A failed MCP connection appears unavailable and does not prevent unrelated agent work. Invalid configuration JSON fails startup with a configuration error. The authenticated inventory endpoint requires `agents:read` for the requested outline and never returns commands, headers, or environment values. The API cannot install or launch arbitrary backend commands; that authority stays with the operator.

## Compatibility and limits

- Transports: stdio and Streamable HTTP. The client negotiates modern MCP and compatible 2025 protocol versions through the official SDK. Legacy HTTP+SSE is not supported.
- Authentication: explicit stdio environment variables and HTTP headers; local HTTP also supports public-client browser OAuth. Backend OAuth, device code, confidential-client login, and provider presets are not supported.
- Remote URLs require HTTPS. Explicit `localhost`, `127.0.0.1`, and IPv6 loopback URLs may use HTTP. URL credentials, query strings, fragments, and redirects are rejected; use headers for credentials.
- Tools: JSON object input schemas, text results, and structured JSON results. Binary output and resource content are identified as unsupported. MCP prompts, resources, sampling, elicitation, and apps are not enabled.
- Discovery is bounded to 256 tools and 250,000 characters of metadata per connection; input schemas are bounded to 32,000 characters and reject external references. Existing agent policy limits still apply: at most 64 selected tools. Discovery never sends the whole inventory to the model automatically.
- Connections and discovery have a 20-second deadline, individual calls have a 60-second deadline, transport responses are bounded to 2 MB, and result text is truncated before reaching the model.
- Connections are owned by each run and closed on completion, failure, or cancellation. The run loads current validated definitions for admitted remote names, verifies the connection binding, and exposes only approved tools. Missing tools or changed bindings fail before execution; description/schema changes do not.
- Backend MCP execution requires the Pi engine. MCP tools are not loaded as Forage extensions or as Pi packages.

## External effects and retries

MCP tools may create, modify, or delete external data. Forage does not automatically retry MCP calls, and turns with MCP tools disable provider and empty-response retries. Backend MCP runs have one attempt, including after lease expiry. A cancelled or failed call may already have changed the external system; cancellation cannot undo that change. Check the external system before explicitly retrying.

Tool results remain untrusted material. MCP results follow Forage's ordinary bounded output and structured outline placement rules; connecting a server does not give it direct access to the editor or bypass `emit_outline`.
