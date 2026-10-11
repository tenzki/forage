## Why

A new Forage installation opens a capable outliner without helping the user create a first note, connect AI, configure extensions, or connect tools through MCP. The agreed onboarding in `docs/desktop.pen` introduces these capabilities through a short setup flow using the user's own note.

## What Changes

- Add a minimal onboarding window with five steps: write a first note, connect AI and choose a model, run `/brainstorm` on that note, optionally select and configure extensions, and optionally connect MCP servers.
- Use a plain application window with brief instructions, an editing or configuration area, and bottom navigation. Keep the full workspace sidebar, toolbar, Activity panel, and tutorial rail out of this flow.
- Preserve the user's note and generated result as ordinary outline content, using existing document editing, persistence, undo, context admission, and skill execution.
- Reuse provider connection and model selection from `redesign-settings`, with verified connection states and explicit default selection.
- Offer compatible extensions with clear account requirements; guide selected sources through installation where necessary, configuration, trust, tool grants, and explicit command creation using existing services.
- Keep extension selection optional. Place **Skip for now** in onboarding navigation beside **Configure selected**, as agreed for Pen node `fEDLl`.
- Add MCP setup after extensions: explicitly scan/import connections from supported local clients or add a server by URL or launch command. Keep **Skip for now** in bottom navigation and defer individual tool/assistant permissions to Settings → MCP servers; connecting grants no new tool access.
- Persist device-local progress so setup can be resumed. Allow users to skip setup and enter a working local outline; avoid automatically interrupting existing installations on upgrade.
- Finish with a concise summary and **Open Forage**, retaining successful setup and user content.

## Capabilities

### New Capabilities

- `desktop-onboarding`: Minimal first-run setup, real note editing and AI invocation, provider/extension/MCP configuration entry points, navigation, skipping, resumption, and completion.

### Modified Capabilities

None. This change composes existing provider, document, agent, extension, and MCP contracts without widening their authority or permission rules.

## Impact

- Desktop application startup and shell presentation, a device-local onboarding state store, and reusable provider/extension/skill/MCP configuration controls.
- Integration with `OutlinerEditor`, `OutlineSession`, `skillExecution`, `settingsStore`, `extensionStore`, and `mcpStore`; no separate onboarding document, MCP client, or credential store.
- Depends on `redesign-settings` for provider/model setup and shared MCP presentation/forms, and on `add-mcp-client` for local discovery, connection, secret storage, and tool policy. Compatible with `add-multi-pane-workspace` while retaining one canonical outline authority.
- Focused lifecycle, persistence, configuration, MCP discovery/no-implicit-grant, and run integration coverage, plus native desktop visual verification against Pen screens 09A–09K.
- Server enrollment and backend MCP configuration, mandatory MCP tool demonstrations, image generation demonstrations, Activity tutorials, new provider adapters, and a public extension marketplace remain outside this change.
