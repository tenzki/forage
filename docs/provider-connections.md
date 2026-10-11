# Provider connections

Connection Settings lists configured accounts, not disconnected catalog entries. Use **Add provider** to choose Anthropic, OpenRouter, OpenCode Go, OpenAI, or ChatGPT. The first four use API keys; ChatGPT retains device-code subscription sign-in, account identity, expiry, refresh, and revocation behavior. OpenCode Go is the `opencode-go` Pi provider, not OpenCode Zen.

Connecting an account does not change the default. Explicitly choose a connected default provider and one of its supported models, then **Save defaults**. Provider, model, and credential reference are validated and saved together. Changing the provider clears the model draft instead of selecting a substitute. Agents inherit the execution environment's compute; portable agent configuration contains no model credentials. Disconnecting the default retains its selection as repairable metadata rather than choosing another account.

## Authority

The persisted workspace mode determines the account inventory. Local API keys are stored through native SQLite credential commands under `local-anthropic`, `local-openrouter`, `local-opencode-go`, or the retained `local-openai` reference. ChatGPT retains `local-openai-codex`. General settings contain only account metadata, preferences, and compute references. Failed account persistence restores the previous secret and settings record. Concurrent account mutations are serialized.

Server mode never exposes or edits device accounts. Authorized server connection setup sends the new credential through origin-pinned native transport, validates it on the server, and stores encrypted bytes. Listing returns sanitized metadata scoped to the authenticated owner and outline. Reconnecting preserves the provider account reference, preferring a reference already used by the PostgreSQL compute profile. Profile writes use revision conflicts and update provider/model/reference atomically. Manual, retry, and automatic admissions capture their compute profile; already admitted inputs remain unchanged. The Pi dispatcher uses the same admitted provider runtime, never an OpenAI endpoint with another provider's key.

API keys reach the local sidecar through its child environment, not process arguments. Authentication stays in memory, with no credential-file or model-network discovery. Non-admitted providers cannot use ambient environment keys. Exact pinned Pi model IDs are required, including slash-containing OpenRouter names; unsupported IDs fail rather than falling back.

## Connection validation

API-key checks use authenticated, non-generation GET requests only:

| Provider | Endpoint | Authentication |
| --- | --- | --- |
| Anthropic | `https://api.anthropic.com/v1/models?limit=1` | `x-api-key`, `anthropic-version: 2023-06-01` |
| OpenRouter | `https://openrouter.ai/api/v1/key` | Bearer key |
| OpenCode Go | `https://opencode.ai/zen/go/v1/usage` | Bearer key |
| OpenAI | `https://api.openai.com/v1/models` | Bearer key |

Checks reject redirects, bound response bodies to 100,000 bytes, and finish within ten seconds even if a fetch adapter ignores cancellation. Invalid authentication, access/subscription denial, rate limits, malformed responses, outages, and timeouts return sanitized errors without provider bodies or submitted secrets. Cancel aborts the request and clears the form. Native server setup cancellation drops its pinned HTTP operation; server validation observes request closure before credential enrollment. No model generation request is used as a connection check.

The endpoint contracts are documented by [Anthropic](https://platform.claude.com/docs/en/api/models), [OpenRouter](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key), and [OpenAI](https://developers.openai.com/api/reference/cli/resources/models). OpenCode Go's authenticated [usage route](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts) rejects missing/invalid keys and missing Go subscriptions; its public models route is deliberately not used for authentication validation.

## Compatibility and verification

Local and Pi-engine server execution support all five identities through the pinned Pi 0.84.2 adapters. Legacy-engine servers advertise only OpenAI and ChatGPT. Servers without `supportedProviders` remain readable, but redesigned account/default edits require an upgrade. Unsupported selections and unavailable servers never substitute device accounts or local execution. Workspace disconnect restores the retained local selection without importing server credentials.

Model connectivity does not imply every optional tool is usable. Server image generation still requires an OpenAI API-key credential; ChatGPT and other providers do not silently acquire a billed Images API key.

Deterministic fixtures cover the connection and admission paths without paid model calls. Integrated PostgreSQL contracts passed against the dedicated `forage_contract_test` database, including encrypted account isolation, concurrent enrollment/profile updates, and immutable Inbox admission snapshots. Live provider/entitlement checks and real Tauri visual/restart verification remain manual gates. See [verification evidence](../openspec/changes/redesign-settings/verification.md).

### Upgrade and downgrade preflight

Before changing versions, close the desktop and take consistent, access-protected backups of its settings and native SQLite data, plus the server database where applicable. Settings metadata alone is not a credential backup. Never copy credentials between local and server environments to repair compatibility.

Check the target version's actual provider capabilities and exact model catalog separately for the local runtime and server engine. Missing capability metadata does not prove support. The release fixtures use an illustrative target catalog, not a guarantee that every historical version supports the same models.

If either environment selects an unsupported provider or model, stop the downgrade. While still running the newer version, explicitly connect/select a supported account and exact model in that environment, save its defaults, and verify readiness. Repair the other environment independently; retain credential references and individual MCP/extension permissions. Do not rewrite saved selections, substitute accounts, or reset grants implicitly. Already admitted server runs retain their original profile; drain them or confirm the target runtime supports their captured selections before changing server versions. Deploy a compatible server before relying on redesigned client account edits. These are operator preflight steps, not an automatic downgrade command.
