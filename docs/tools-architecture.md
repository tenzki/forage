# Tool support architecture

## How Pi handles web search

Pi does not ship web search as a privileged built-in tool. The installed `web-search` capability is an Agent Skill:

1. `SKILL.md` advertises “Web search via DuckDuckGo.”
2. When relevant, the model reads that skill.
3. The skill instructs the model to invoke `search.js` through Pi's general-purpose `bash` tool.
4. The script requests DuckDuckGo's HTML endpoint and prints bounded title, URL, and snippet results.

Pi's native tool mechanism is separate. Extensions call `pi.registerTool()` with a name, description, TypeBox/JSON Schema parameters, and an `execute()` function. Pi sends active definitions to the model, executes returned tool calls, appends `toolResult` messages, and asks the model to continue. `pi.getAllTools()`, `pi.getActiveTools()`, and `pi.setActiveTools()` power its tool selector. Pi requires tools to bound output (normally 50 KB or 2,000 lines).

Pi can load arbitrary TypeScript extensions and packages, but explicitly treats them as fully trusted code with the same permissions as the Pi process.

## Approach for this app

This app should not add a shell just to copy Pi's web-search skill. It exposes native model tools instead:

- `web_search`: JSON Schema input for a query and bounded result count, using DuckDuckGo.
- `web_fetch`: validates a public URL and requests clean Markdown through the pre-allowlisted Jina Reader origin.
- Bounded output and 20-second request deadlines.
- A multi-turn model/tool loop using Pi AI's assistant and `toolResult` message formats.
- Persistent enable/disable state in Settings → Tools.

This preserves the frontend-only architecture and grants no filesystem or command-execution capability. Page URLs are disclosed to Jina Reader, which is stated in Settings.

## User-created tools

Users should add **declarative HTTP tools**, not arbitrary JavaScript. A persisted tool definition can contain:

```ts
interface CustomHttpTool {
  id: string
  name: string                 // lowercase letters, digits, underscores
  description: string          // shown to the model
  enabled: boolean
  parameters: JsonSchema       // object schema only, with bounded depth/size
  request: {
    method: 'GET' | 'POST'
    urlTemplate: string         // e.g. https://api.example.com/search?q={{query}}
    headers: Record<string, string>
    bodyTemplate?: JsonValue
  }
  response: {
    jsonPath?: string
    maxCharacters: number
  }
}
```

The first simple HTTP tool form is implemented for public GET endpoints on pre-allowlisted GitHub and Open-Meteo origins. Users provide a name, model-visible description, and path/query template. Every `{{parameter}}` becomes a required JSON Schema string argument. Tools can be enabled, disabled, and removed.

Future creation paths should add:

1. Authenticated curated connectors with secrets stored separately from model-visible definitions.
2. **OpenAPI import** — import a document, select operations, review generated names/schemas, then explicitly enable them.

Secrets should be stored separately and templates should reference them by ID; secrets must never be included in model-visible tool definitions or results.

## Security boundaries

Before allowing arbitrary hosts, add these controls:

- HTTPS only by default.
- Explicit user approval for every origin.
- Block loopback, link-local, private-network, and cloud-metadata destinations, including redirects and DNS resolution results.
- Restrict methods to GET/POST initially.
- Request timeout, response byte limit, tool-call round limit, and per-generation call budget.
- Never interpolate model arguments into header names or destination origins.
- Redact configured secrets from errors and outputs.
- Show the requested origin and arguments while testing a tool.
- Validate imported JSON Schema and reject recursive, huge, or unsupported schemas.

Tauri's HTTP capability is static. Preserving the current frontend-only architecture means custom tools must initially use a curated set of pre-allowlisted public API hosts. Supporting arbitrary origins would otherwise require widening access to `https://*`, which is not recommended: the webview cannot reliably defend against DNS rebinding or redirects to private addresses. Truly arbitrary HTTP tools would require an explicit architecture decision to add a narrow, hardened Rust networking command.

## Recommended rollout

1. **Built-in web search and webpage reading** — implemented and toggleable.
2. **Curated custom HTTP tools** — implemented for public GET requests to GitHub and Open-Meteo.
3. **Tool activity UI** — show compact call/result details in the generated branch.
4. **Authenticated connectors and OpenAPI import/export** — portable declarative tool bundles; arbitrary hosts require the hardened-networking architecture decision above.
5. **Signed or sandboxed extensions** — only if declarative tools prove insufficient; do not run untrusted TypeScript in the webview.
