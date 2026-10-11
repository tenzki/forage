# Settings redesign foundation

## Dependency checklist (task 1.1)

The current implementations, not superseded phase plans, are the integration baseline.
The following boundaries apply to subsequent settings tasks as well as this foundation.

- [x] `add-mcp-client`: reuse `packages/mcp-host`, `packages/agent-runtime/src/mcp.ts`, desktop `mcpStore.ts`, MCP components, native management transport, and server MCP admission. Shared editing points are `settingsStore.ts`, agent tool IDs, Settings navigation, and readiness. Keep individual fingerprinted grants; do not introduce a wildcard, master bit, second discovery service, or desktop editor for server commands/secrets. This foundation leaves MCP configuration and grants untouched.
- [x] `add-system-one-skills`: reuse generic extension executors in `packages/extension-api`, `packages/extension-host`, `packages/agent-runtime/src/extensions.ts`, `extensionStore.ts`, and existing skill editors. Shared editing points are `definitions.ts`, `settingsStore.ts`, `AgentSettings.tsx`, and `ExtensionsSettings.tsx`. Keep unavailable references, executor-owned configuration, trust decisions, and ordinary output. No System One-specific core types, automatic skill creation, or extension runtime rewrite is added here.
- [x] `run-pi-on-server`: the shared runtime is `packages/pi-runtime` with both Pi packages pinned to `0.84.2`. Shared editing points are `runtime-auth.ts`, `apps/server/src/piExecutor.ts`, and desktop sidecar `index.ts`/`run.ts`. Catalog inspection and exact model resolution live in the shared package; do not create another provider registry, session runner, prompt composer, or conversation store. Authentication expansion belongs to task 2.2.
- [x] `add-server-agent-executor`: reuse `packages/agent-runtime/src/contracts.ts`, `packages/protocol/src/agent.ts`, server `app.ts`, `credentialService.ts`, `agentStore.ts`, `postgresAgentStore.ts`, `serverRunner.ts`, and desktop `serverExecutor.ts`/`serverConfigurationSync.ts`. Compute and credentials remain environment-owned and server admission remains authoritative. This foundation broadens readable contracts and reports only currently executable providers. Native credential payloads, encrypted server storage, new-provider provisioning, and admitted execution expansion remain tasks 2.1–2.3.

All four changes already have implemented integration surfaces. Their remaining smoke or product tasks are not implicitly completed by this change. No document events, synchronization settings, portable agent definitions, extension trust records, MCP grants, or admitted run snapshots are migrated by local settings migration.

## Pinned provider matrix (task 1.2)

Source of truth: installed `@earendil-works/pi-ai@0.84.2` provider factories and catalogs, resolved by `@earendil-works/pi-coding-agent@0.84.2`. Display labels are never used as endpoints. Catalog tests enumerate every advertised model and resolve its exact provider/model identity without network access.

| Choice | Stable identity / Pi provider | Forage authentication | Pinned APIs | Catalog models |
| --- | --- | --- | --- | --- |
| Anthropic | `anthropic` | API key | `anthropic-messages` | 13 |
| OpenRouter | `openrouter` | API key | `openai-completions` | 346 |
| OpenCode Go | `opencode-go` (not `opencode`, which is Zen) | API key | Per-model `anthropic-messages`, `openai-completions`, `openai-responses` | 19 |
| OpenAI | `openai` | API key | `openai-responses` | 38 |
| ChatGPT | `openai-codex` | Subscription OAuth, account ID and expiry | `openai-codex-responses` | 7 |

The first three factories already exist in the pinned dependency, including mixed-protocol OpenCode Go dispatch, so no replacement wire adapter or dependency upgrade is needed for catalog mapping. Anthropic/OpenRouter OAuth, custom endpoints, and OpenCode Zen are not supported Forage identities. Provider-specific connection validation and production auth wiring still require tasks 2.1–2.4; these deterministic tests do not claim live connectivity.

Pi's CLI resolver permits fuzzy matching/fallback and can misinterpret slash-containing OpenRouter IDs. Forage's shared adapter now uses exact `getModel(provider, modelId)` and rejects unavailable combinations rather than changing compute silently. The shared model-ID contract also accepts the pinned OpenRouter catalog's `~`-prefixed aliases.

## Contract and capability boundary (task 1.3)

Compute profiles retain version 1 and their existing provider/model/credential reference shape. Credential references, sanitized metadata, and API-key enrollment contracts admit the five explicit identities. Portable agents remain model/credential-agnostic. Strict schemas reject secret fields and incompatible authentication metadata.

Readiness optionally includes `supportedProviders`, with authentication and exact model IDs. An older response remains readable, but absent metadata never grants support for a new choice. At the foundation stage the server reported only OpenAI and ChatGPT. Task group 2 subsequently enabled all five identities for Pi-engine servers; legacy-engine servers still advertise only OpenAI and ChatGPT. Capability descriptors are a vocabulary, not enablement.

## Local migration (task 1.4)

`localSettingsV1` is a version-1, non-secret device record: one account per provider/authentication identity, an explicit local compute selection, and device preferences. Existing native-vault IDs are retained. A missing selected account is retained as a repairable reference; another account is never substituted. Existing version-1 records win over stale legacy fields; unknown versions or invalid account/selection records fail without overwriting them.

Legacy `codexAuthMode`, `codexModelId`, and `localModelCredentials` seed the record once. Existing legacy secret migration continues to move OpenAI/ChatGPT bytes to native SQLite and remove plugin-store secret fields. Legacy UI setters keep the new record and compatibility metadata synchronized through a serialized persistence path, so reloading cannot undo later changes. No provider secrets enter the new record.

Defaults are system theme, default outline font/size, and following system motion. `default` size deliberately inherits the current stylesheet's 15px outline instead of coercing an upgrade to 14px or 16px; explicit sizes are 12, 14, 16, 18, 20, and 24px. Invalid individual preference values fall back safely. Appearance application, preference editing, and save/retry UI are task 3.2.

The existing `docs/desktop.pen` General/Connection designs were inspected via Pencil. No design changes are needed for this foundation; the illustrative override and result-placement controls are explicitly scheduled for task 3.5.
