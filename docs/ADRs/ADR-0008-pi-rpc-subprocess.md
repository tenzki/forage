# ADR-0008: Run Agent Work in a Pi RPC Subprocess

- **Status:** Accepted
- **Date:** 2026-08-17
- **Deciders:** AI Chat project team
- **Supersedes:** ADR-0005
- **Superseded by:** None

## Context

The direct `pi-ai` integration proved streaming, Codex authentication, and bounded tools, but recreates Pi's agent loop and cannot load Pi skills, extensions, or packages. Extensible tools and configurable agents are now a product requirement.

The earlier sidecar architecture also included custom Rust IPC, SQLite storage, and a second session tree. Those additional seams caused most of its complexity. The current app has a single TipTap document and can communicate directly with a child process through the official Tauri shell plugin.

## Decision

We will run agent work in a **Pi process using its JSONL RPC mode**, launched directly by the TypeScript frontend through `@tauri-apps/plugin-shell`.

The bridge runs with Pi's built-in tools and automatic resource discovery disabled. One explicitly loaded extension registers:

- `/ai-chat-run`, which applies a persisted app agent and skill profile and sends the task to Pi.
- `emit_outline`, a terminating structured-output tool.
- Bounded `web_search` and `web_fetch` tools plus validated custom HTTP GET tools for two approved public API origins.
- An opt-in `generate_image` tool that uses `gpt-image-2` and returns validated raster output as a separate image-only `emit_outline` node. Subscription mode delegates to Codex's built-in image tool; API-key mode calls the public Images API.

Settings persist typed agent definitions (instructions, model override, tool allowlist) and skill definitions (slash label, instructions, assigned agent, automatic context strategy). A context strategy resolves a command-relative root (`invocation`, `parent`, or `previousSibling`) and composes self, ancestor, descendant, and sibling selectors with explicit depth, node, character, filtering, and overflow limits. Global tool enablement is intersected with the selected agent's allowlist before each run.

The frontend sends the selected Codex credential and ChatGPT account id through the Pi child environment, listens to Pi lifecycle and tool events, and applies emitted outline nodes in a single ProseMirror transaction. Credentials are never included in model context. No custom Rust commands or external agent-session mapping are introduced.

In subscription mode, the image tool starts a short-lived Codex app-server using its documented experimental `chatgptAuthTokens` login mode for host-managed OAuth. Codex runs with an isolated temporary `CODEX_HOME`, temporary workspace, no inherited secret environment variables, read-only sandboxing, and shell, web, app, connector, memory, hook, and multi-agent features disabled. The OAuth token is sent over app-server stdin rather than process arguments, and the temporary credential cache is removed after every request. The resulting PNG is validated and bounded before it crosses the Pi bridge; only an opaque image id enters the primary Pi model context. This path consumes included Codex limits.

In API-key mode, the bridge calls the public Images API directly, producing a bounded WebP and using standard API billing. ChatGPT OAuth is never sent to the public Images API.

## Consequences

### Positive

- Pi owns the agent loop, tool validation, streaming lifecycle, and cancellation.
- The process boundary can later host approved Pi skills, tools, extensions, and packages.
- Arbitrary extension code does not execute inside the webview.
- Structured output supports nested outline nodes without parsing markdown lines.
- The editor remains the source of truth and preserves native undo.

### Negative

- Development currently requires compatible `pi` and `codex` executables on `PATH`.
- Codex app-server's host-managed token mode is documented but experimental and may change between CLI releases.
- Production still needs pinned, bundled, signed, and notarized Pi/Node and Codex runtimes.
- Pi extensions run with the user's OS permissions and require an explicit trust policy.
- Standard RPC does not provide arbitrary callbacks into host-side tools.
- Process startup, JSONL framing, stderr reporting, and lifecycle cleanup become application concerns.

## Security Boundary

The app starts Pi with `--no-builtin-tools`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-context-files`, then explicitly loads only the bundled bridge extension. Third-party Pi package installation remains disabled until a separate permission and trust design is accepted.

Credentials are passed to Pi through environment variables, never command arguments, prompts, tool definitions, or logs. The nested Codex process receives only an access token and account id through local JSON-RPC stdin; its spawned environment excludes app credentials. The bridge validates and bounds invocation payloads, tool configurations, URLs, network output, generated-image counts and bytes, and structured output. Custom HTTP tools are HTTPS-only, cannot contain credentials, reject redirects, and are restricted to explicitly approved public origins. Generated images use bounded PNG or compressed WebP data URLs only after signature/size validation; SVG and remote image URLs are rejected. The data URL is persisted inside the existing versioned TipTap JSON document, so no broader app filesystem or HTTP capability is required.

## Implementation Notes

- `src/agent/piRpcClient.ts` owns Tauri process lifecycle and RPC request correlation.
- `src/agent/piGeneration.ts` maps Pi events to the existing editor generation callbacks and applies global/per-agent tool policy.
- `src/agent/definitions.ts` defines and validates persisted agents, slash-command skills, and context strategies.
- `src/agent/context.ts` resolves bounded context nodes in document order while preserving outline indentation.
- `src/editor/contextPreview.ts` decorates automatically selected nodes only while the command is focused.
- `src/components/Settings/AgentSettings.tsx` provides agent and skill configuration.
- `src-tauri/resources/pi/ai-chat-bridge.ts` registers the internal command and output tool.
- `src-tauri/resources/pi/codex-image-generation.ts` owns the isolated Codex app-server JSON-RPC lifecycle.
- `src/agent/insertIntoEditor.ts` applies text fallback or structured nested output.
- `src-tauri/capabilities/default.json` fixes the allowed executable and argument shape.

The old direct provider loop remains temporarily as tested migration code, but branch-local generation now uses Pi RPC.

## Validation

- Pi starts through the scoped Tauri shell command.
- RPC commands are LF-delimited JSON and correlated by request ID.
- Codex credentials do not appear in process arguments or model context.
- `/ai-chat-run` invokes the selected agent and skill instructions with branch context.
- Configured skills appear in the slash menu after persistence.
- Existing persisted skills migrate to the prior lineage behavior (ancestors plus invocation node).
- Current-node, lineage, current/parent/previous branches, current-level, neighboring-branch, and custom automatic strategies resolve deterministically.
- Nodes selected by the active strategy receive temporary editor decorations while its slash command is composed and focused; those decorations never enter the document or undo history.
- Only tools enabled globally and allowed by the selected agent are activated.
- `emit_outline` terminates the run and returns validated nested nodes, optionally resolving opaque image ids produced during that run.
- Image generation is disabled globally by default, intersected with each agent allowlist, limited to one bounded image per run, and cancellable with the existing Pi abort path.
- Subscription image generation uses the user's Codex entitlement without exposing ChatGPT OAuth to the public Images API; API-key mode remains separately billed.
- Generated images are persisted as distinct `generatedImageItem` outline nodes, never appended to text `listItem`s; they survive JSON reload and are removed with their generated branch by one undo.
- Cancellation sends RPC `abort` and terminates the child during cleanup.
- One undo removes the generated outline branch.

## References

- `docs/ADRs/ADR-0005-direct-codex-access.md`
- `docs/ADRs/ADR-0006-branch-local-agent-generation.md`
- `src/agent/piRpcClient.ts`
- `src/agent/piGeneration.ts`
- `src-tauri/resources/pi/ai-chat-bridge.ts`
- `src-tauri/capabilities/default.json`
- [Codex app-server](https://developers.openai.com/codex/app-server/)
- [Codex image generation](https://developers.openai.com/codex/image-generation/)
- [OpenAI image generation API](https://platform.openai.com/docs/guides/image-generation)
