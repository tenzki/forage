# MCP servers

Forage can connect to user-supplied MCP servers and expose their tools to agents. There is no preset provider catalog and no Forage extension to write. Both desktop and backend agents use the same MCP client and Pi tool adapter.

## Desktop setup

1. Open **Settings → MCP servers**. Forage automatically uses the same local or server mode as your agents; there is no separate MCP location selector.
2. In local mode, **Found on your computer** lists MCP connections configured in supported clients. For example, Pen registered with Codex appears with **Found in Codex** and a **Connect** button.
3. Click **Connect**. If credentials cannot be reused, enter the requested values first. Forage connects to the server and opens tool review and agent selection.
4. Choose the tools and agents, then click **Enable for selected agents**. Connecting alone does not authorize tools. **Done for now** leaves the connection saved without granting additional access.

Use **Choose agents** on any connected server to add its reviewed tools to agents later. Existing agent access is preserved. Individual global tool switches and the agent editor remain available for more detailed access changes.

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

Scanning launches no MCP commands and returns names, sources, transport, missing credential field names and sanitized issues only. Identical definitions are combined across sources; variants with different arguments or settings stay separate. Imports already saved in Forage are marked **Already connected**. A changed source definition requires **Scan again** before import. A missing or invalid source does not block the others.

Forage copies a connection when you click Connect; it never edits the source client's configuration or follows subsequent changes automatically. Literal environment/header credentials are copied into Forage's native credential store. Explicit Codex environment references use variables available to the management process; unavailable values and client input placeholders become credential fields. Enter complete header values, such as `Bearer your-token`, when a header is requested. App-specific authentication, tool restrictions, unsupported transport types and command/URL placeholders require advanced setup. Scanning does not provide interactive OAuth.

Pen must be running with the intended document open when its tools are used. Discovery finds its registered configuration, not every installed app. Forage does not install Pen, language runtimes, or arbitrary MCP bundles. Local Pen connections cannot be imported into a remote backend.

### Advanced setup

If the server was not found, expand **Advanced setup**, enter a **Server name** and choose **Connect using**:
   - **Server URL:** enter the Streamable HTTP endpoint and, if needed, an access token. The token is sent as a Bearer token. Use **Additional headers** for other authentication headers.
   - **Launch command:** paste the server's command, such as `npx -y your-mcp-package` or `uvx your-mcp-package`. Add environment variables using the name/value fields. A working directory is optional.

Click **Connect server**, then **Choose agents** to grant access. Install the runtime or executable required by your MCP server first. Forage uses the Node.js available to the desktop sidecar; Python servers may require Python and `uv`/`uvx` separately.

If a setup guide supplies `mcpServers` JSON, use **Advanced setup → Advanced: import JSON → Import and connect**. For example:

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

Use **Refresh tools** after a server update. Changed descriptions, schemas, commands, or endpoint bindings produce new tool permission IDs: enable and select the changed tools again. Unchanged tools keep their IDs. Disable a connection to make its tools unavailable; removing it also deletes its saved configuration. To change a command, URL, or credential, remove the connection and add the updated configuration.

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

Open **Settings → MCP servers** while Forage is in server mode. The backend inventory loads automatically, and the agent picker shows these tools. Use **Choose agents** to enable reviewed tools for selected agents; the normal configuration publication sends tool references to the backend. Backend tools can run while every desktop is closed, including through Inbox automation. Local and backend tool IDs are distinct, so each environment needs explicit tool authorization. An unavailable backend reports an error instead of falling back to device-local connections. Backend connections are still added by the operator through the configuration file; device discovery and import run only in local mode.

The backend reads configuration and discovers tools at startup. Restart it after changing the file or updating a server, then refresh backend tools in Settings. A failed MCP connection appears unavailable and does not prevent unrelated agent work. Invalid configuration JSON fails startup with a configuration error. The authenticated inventory endpoint requires `agents:read` for the requested outline and never returns commands, headers, or environment values. The API cannot install or launch arbitrary backend commands; that authority stays with the operator.

## Compatibility and limits

- Transports: stdio and Streamable HTTP. The client negotiates modern MCP and compatible 2025 protocol versions through the official SDK. Legacy HTTP+SSE is not supported.
- Authentication: explicit stdio environment variables and HTTP headers. Interactive OAuth is not yet implemented; OAuth-only services need a separately authenticated bridge.
- Remote URLs require HTTPS. Explicit `localhost`, `127.0.0.1`, and IPv6 loopback URLs may use HTTP. URL credentials, query strings, fragments, and redirects are rejected; use headers for credentials.
- Tools: JSON object input schemas, text results, and structured JSON results. Binary output and resource content are identified as unsupported. MCP prompts, resources, sampling, elicitation, and apps are not enabled.
- Discovery is bounded to 256 tools and 250,000 characters of metadata per connection; input schemas are bounded to 32,000 characters and reject external references. Existing agent policy limits still apply: at most 64 selected tools. Discovery never sends the whole inventory to the model automatically.
- Connections and discovery have a 20-second deadline, individual calls have a 60-second deadline, transport responses are bounded to 2 MB, and result text is truncated before reaching the model.
- Connections are owned by each run and closed on completion, failure, or cancellation. The run checks discovered tool definitions against its admitted snapshot before calling tools. A changed or missing tool requires refresh and review.
- Backend MCP execution requires the Pi engine. MCP tools are not loaded as Forage extensions or as Pi packages.

## External effects and retries

MCP tools may create, modify, or delete external data. Forage does not automatically retry MCP calls, and turns with MCP tools disable provider and empty-response retries. Backend MCP runs have one attempt, including after lease expiry. A cancelled or failed call may already have changed the external system; cancellation cannot undo that change. Check the external system before explicitly retrying.

Tool results remain untrusted material. MCP results follow Forage's ordinary bounded output and structured outline placement rules; connecting a server does not give it direct access to the editor or bypass `emit_outline`.
