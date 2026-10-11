## Context

See `proposal.md` for motivation and `specs/local-mcp-oauth/spec.md` for the behavior contract. `add-mcp-client` and `redesign-settings` contain the implemented foundations but are not yet archived into canonical MCP specs; this change introduces a separate additive capability rather than editing those changes.

Current HTTP MCP configuration contains an endpoint and static headers. `packages/mcp-host/src/index.ts` constructs the Streamable HTTP transport without an authorization provider. Connection/tool metadata lives in plugin-store; sensitive configuration lives under `forage-mcp/<connection-id>/configuration` in the native SQLite credential store. That store is not an OS keychain or a new encryption-at-rest guarantee.

MCP management currently uses one JSONL request/result per process, a 30-second frontend deadline, and a 20-second connection/discovery deadline. Runs create separate MCP sessions. An interactive consent flow and durable refresh-token rotation cannot safely be added by merely increasing those deadlines or copying access tokens into static headers.

The installed `@modelcontextprotocol/client` 2.1.0 exposes OAuth discovery, registration, PKCE, token exchange, and refresh facilities. Its transport also supports automatic retries after authorization failures. Forage must control that behavior because its existing MCP policy forbids replay of potentially mutating calls.

### Design references

All nodes are in `docs/desktop.pen`; inspect through Pencil, never by parsing the file directly. The original `i7FjPu` launch-command screen remains unchanged.

| State | Node | Meaning |
| --- | --- | --- |
| URL setup / Browser sign-in | `stRd6` | Generic endpoint, authentication selector, explicit Sign in and connect |
| Waiting for consent | `qJgcM` | Frozen fields, browser recovery links, Cancel sign-in |
| Connected / review access | `mcOhA` | Authorization saved, new tools/agents unchecked, explicit Save access |
| Sign-in not completed | `vE4Au` | Draft retained, no new connection or grants, explicit fresh retry |
| Existing connection needs sign-in | `ZHz9y` | Saved permissions visible read-only, execution unavailable, Sign in again |
| Manual credentials | `rawFS` | Existing Bearer/header setup with independent draft |
| Interaction notes | `zJH7u` | State transitions, ownership, cancellation, and implementation boundaries |

Screens inherit the existing shell, navigation, 640 px content width, spacing, fields, neutral server icon, and button components. Jira is example data, not a verified brand or provider integration. Review must use the discovered inventory, not the illustrative discovery/execution labels, and must not imply that a broad execution tool is read-only.

## Goals / Non-Goals

**Goals:** Local HTTP OAuth with explicit consent; generic metadata-driven interoperability; durable, connection-scoped authorization; permission-independent recovery; bounded processes and network work; unchanged external-action safety.

**Non-Goals:** Backend OAuth, importing other clients' OAuth stores, automatic consent, embedded webviews, a hosted token broker, shipping a provider-specific client secret, device-code/client-credentials/DPoP flows, and recreating Atlassian's consent screen. Services that require unsupported grants or registration must receive an honest compatibility error.

## Decisions

### 1. Explicit authentication modes with backward-compatible defaults

Extend local HTTP configuration with an explicit authentication descriptor. Browser configuration carries non-secret registration options/references, never a persisted static Bearer token as a substitute for OAuth. Manual credentials retains existing Bearer/header semantics; None submits no authorization credential. Browser sign-in rejects a custom Authorization header; manual Bearer and custom Authorization remain mutually exclusive. Preserve other explicitly supplied headers only within their configured server binding.

New URL setup follows the Pen Browser sign-in choice. Existing saved/imported configurations without a descriptor retain their prior manual/no-auth meaning and must not start OAuth because a server returns 401. Each authentication mode and the launch-command method has its own draft; switching cancels pending authorization and submits only the selected fields. Advanced JSON can express supported public-client registration options without requiring an ordinary user to paste a token.

Alternative: replace the token field with implicit OAuth on any 401. Rejected because it changes existing configurations, can open browsers unexpectedly, and blurs credential ownership.

### 2. Metadata-driven public-client registration, not a Jira integration

Use the official SDK for protected-resource metadata, OAuth/OIDC authorization-server discovery, registration, PKCE, exchange, and refresh. Apply the SDK's advertised registration selection rules when the necessary configuration exists: an explicitly configured public client metadata URL, a pre-registered public client ID, or supported dynamic registration. Dynamic registration is the zero-token default where supported. Persist registration keyed by connection/resource and validated issuer, not by the server's display name.

Do not introduce a hosted metadata document as a hidden deployment dependency. A metadata URL or pre-registered public ID can be supplied through advanced configuration; a server requiring registration Forage cannot complete receives an actionable limitation instead of a fabricated client ID, borrowed client identity, or weakened validation. Native clients must not rely on a secret embedded in the app. Dynamically issued sensitive registration material, if needed by a compatible server, stays in the credential vault.

Issuer and token endpoints can legitimately differ from the MCP host. Discover and validate that relationship rather than assuming a shared hostname. Bind authorization and token requests to the admitted resource and requested scopes; do not widen scopes silently during a run. The [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery), and [registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration) documents define the interoperability/security reference.

Alternative: run `mcp-remote` as Forage's authentication implementation. Rejected for the native experience because it adds an external executable/cache and disconnects credential ownership, cancellation, and refresh from Forage.

### 3. Separate interactive authorization from ordinary discovery

Introduce a dedicated bundled Node OAuth worker controlled by the application/native boundary. Reuse SDK protocol logic, but expose validated bounded lifecycle messages instead of ordinary activity events: checking support, waiting for browser, exchanging authorization, discovering tools, completed, cancelled, or failed. The existing scan and one-shot discovery paths remain noninteractive.

The native/application coordinator assigns an unguessable job ID and owns start, cancel, request binding, process cleanup, and staged credentials. UI messages contain sanitized status and the active authorization URL for explicit browser/link actions, never token responses, verifier, authorization code, or client secret. The authorization URL is ephemeral, excluded from logs, persisted settings, diagnostics, and run transcripts. Callback parameters are never broadcast to the UI.

Bind an ephemeral HTTP listener to a loopback interface before constructing/registering the exact callback URI. Register and reuse the exact active host, port, and path; support secure provider-compatible loopback forms without wildcard listening. Generate fresh PKCE S256 and unpredictable state for every attempt. Validate state, the bound callback, and issuer before exchanging a code; a present issuer must match, and a required issuer cannot be omitted. Consume a valid callback once. The callback response has no remote assets, no secrets, and no referrer/cache leakage. Close the listener on every terminal path.

Only explicit Sign in and connect, Sign in again, and Open browser again can request the native system-browser opener. Validate the destination against the active authorization job. The opener is not an arbitrary URL or subprocess execution API. Copy sign-in link copies only that job's active authorization URL.

Use a five-minute total interactive deadline, with independently bounded network/IPC work; retain current ordinary discovery/call limits. Cancel, changing connection details/mode, leaving setup, disconnecting, workspace-mode switching, and application exit invalidate the active job. Late callbacks/results must not commit credentials or metadata. Open browser again reuses the request; Try sign-in again cancels it and creates a new request.

Alternative: embed login in the webview or relax the current discovery timeout. Rejected for security, provider compatibility, and incomplete cancellation/commit semantics. Native browser authorization follows the [native-app OAuth guidance](https://www.rfc-editor.org/rfc/rfc8252).

### 4. Application-owned authorization broker and native credential commits

Introduce one application-owned broker for local MCP authorization, with native connection-scoped mutation/locking and credential-version checks. Node workers perform protocol/network work; they do not independently write refresh-token snapshots. The broker is the only commit authority, shared by management and concurrent run sidecars. Narrow native operations validate connection references and job/generation/version bindings. Do not expose arbitrary vault keys or arbitrary worker commands.

Persist tokens, expiry, granted scopes, resource/issuer binding, and sensitive registration under a separate scoped OAuth credential record in the existing native store. Plugin-store contains only non-secret auth method/status and connection/tool metadata. PKCE state/verifier and callback codes are temporary. Model credentials, MCP authorization, and backend credentials remain separate. Access tokens travel only through trusted bounded credential IPC to the admitted MCP host; refresh credentials are not placed in run admission snapshots or general activity messages.

For a new connection, stage authorization until token validation, bounded tool discovery, and metadata persistence succeed. Final failure/cancellation removes temporary credentials and creates no visible connection or grants. A persistence error is not reported as successful connection. Best-effort remote revocation of a staged grant is cleanup, not a guarantee that provider consent was undone.

For reauthentication, bind the job to the existing connection and its generation. Failed/cancelled reauthentication must not erase prior permissions or overwrite a newer credential record. Successful reauthentication retains the connection ID. Discovery preserves permission IDs and saved selections for existing remote names on the same binding, including updated definitions; removed tools are deauthorized and new tools remain unchecked (ADR-0025). A token rotation by itself is not a tool-definition change. Because provider APIs may not expose a stable account identity, every successful interactive reauthentication pauses prior grants for explicit review/Save access before they can execute again; preserve existing selections and clearly require account-access review. Do not silently carry active grants to a different signed-in account/site.

Alternative: let each run load and refresh its own serialized OAuth record. Rejected because refresh-token rotation races, disconnects, and late callbacks could overwrite newer credentials or resurrect deleted authorization.

### 5. Refresh before requests without automatic MCP replay

Resolve authorization through the broker before connecting and before issuing an HTTP request when expiry requires refresh. Serialize refresh per connection, re-read the current version under the lock, atomically persist returned rotation/expiry, and reject stale commits. A successful refresh response without a replacement refresh token retains the previous token when allowed by the provider. Missing refresh capability requires explicit sign-in after expiry. Cancellation of one run does not corrupt credentials needed by another run.

The runtime MCP transport uses a noninteractive token provider, not the full interactive OAuth provider. Do not install the SDK's `onUnauthorized` retry hook, and keep insufficient-scope handling as throw. A sent MCP request receiving 401/403, a transport error, or an ambiguous result is not retried. Do not retry a timed-out refresh-token exchange either: a rotating grant may already have been consumed; report uncertainty and require explicit recovery instead of replaying it.

Invalid/revoked grants mark Sign-in required and make tools unavailable. A temporary network/provider failure is an unavailable/retryable connection error, not proof of revoked consent, and must not delete authorization. Scope escalation requires an explicit Settings action and fresh review, never a browser from a run. A refresh or new sign-in never resumes/replays a failed agent turn.

Existing MCP admission, definition checks, result bounds, per-run cleanup, and single-attempt turn policy remain authoritative. This explicitly avoids the installed SDK's default authorization-request replay path.

### 6. Keep consent, connection, and tool access separate

After a new connection is committed, open the existing explicit tool/agent review. New selections start unchecked. Save access stages selected global tool enablement and additive grants to selected agents; it does not erase unrelated permissions or require agents for a global-only save. Cancel review keeps the connection and credentials without new grants.

Sign-in required keeps the last saved inventory/grants visible read-only but unavailable. Successful interactive reauthentication goes through review as described above. Expanded descriptions remain independent of permission switches. Render actual discovered tool names; an Atlassian execution gateway is not a read-only Jira permission merely because a friendly label says so.

Disconnect first invalidates jobs/generation and denies future credential resolution, then deauthorizes tools and removes local credential/configuration records. Late refresh/sign-in writes fail their version/generation checks. Existing in-flight external actions cannot be undone. Attempt remote revocation only when supported and bounded; remote failure cannot prevent local removal or falsely promise that provider consent was revoked.

Alternative: enable tools immediately after provider consent. Rejected because OAuth scopes are not Forage's global/per-agent allowlist.

### 7. Network, metadata, and error boundaries

Apply deadlines and response-size limits to metadata, registration, token, refresh, and revocation requests as well as MCP discovery. Validate endpoint schemes and issuer/resource relationships. OAuth remote endpoints require HTTPS; explicit loopback fixture/local services can use HTTP. Do not forward static MCP headers/tokens to metadata or an authorization server. Token/registration requests must not follow credential-bearing redirects; authorization navigation happens only in the system browser. Validate discovered URLs against private-network/loopback access rules so remote metadata cannot redirect credential work into local services. Preserve explicitly configured local MCP support without creating an OAuth discovery SSRF bypass.

Treat metadata, scopes, descriptions, and provider errors as bounded untrusted input. Exclude tokens, codes, verifier, registration secrets, authorization URLs, and raw OAuth response bodies from tool metadata, diagnostics, errors, and activity. Callback validation errors use local fixed messages and must not display a mismatched issuer's error payload. None and manual configurations retain existing endpoint/header behavior, including no query credentials or legacy SSE expansion.

### 8. Local-only ownership and release verification

Backend inventory remains operator-owned and has no new desktop OAuth controls, callbacks, credentials, or fallback. OAuth-only local imports begin their own Forage consent flow only after explicit user action; scans never read another client's credential database. No new onboarding entry point is included; a future onboarding composition can reuse these services without granting tools.

Use deterministic OAuth/MCP fixture servers for automated verification, including refresh rotation, wrong/late callbacks, scope errors, storage failures, and no duplicate external calls. User-performed native verification checks real system-browser return, clipboard recovery, keyboard/focus behavior, cancellation/exit, restart, and the Pen screens. No Computer Use, alternate GUI automation, or agent-operated browser verification is permitted under project instructions.

Atlassian documents [OAuth consent for its hosted MCP server](https://support.atlassian.com/atlassian-ai-gateway/docs/configure-oauth-2-1/) and [administrator-controlled loopback/domain access](https://support.atlassian.com/security-and-access-policies/docs/available-atlassian-mcp-server-domains/). Actual Forage registration/redirect acceptance and tool discovery at `https://mcp.atlassian.com/v2/mcp` are a manual interoperability gate, not an assumed guarantee. Do not disguise Forage as an approved client or bypass administrator restrictions.

## Risks / Trade-offs

- [Provider rejects public registration, callback, or administrator policy] → Supported registration configuration and truthful errors; validate Atlassian interoperability manually before claiming it works.
- [Rotating refresh tokens and concurrent runs] → One broker, serialized refresh, atomic versioned commits, and no ambiguous token-exchange replay.
- [Different account/site after sign-in] → Preserve saved selections but require explicit access review after every interactive reauthentication.
- [Callback spoofing or discovered-endpoint SSRF] → PKCE/state/issuer/resource binding, one-shot loopback callbacks, and constrained bounded network requests.
- [SDK auth middleware retries a mutation] → Noninteractive token-only runtime provider, throw on scope escalation, fixture tests asserting exactly one external call.
- [Disconnected connection resurrected by late work] → Invalidate generations before cleanup and reject late commits.
- [Vault limitations] → Reuse the current native store without claiming new encryption/keychain protection; document the actual boundary.
- [Signed-in but ungranted connection is confusing] → Separate connected/authorization/review states and explicit permission copy.

## Migration Plan

1. Add backward-compatible HTTP auth/status contracts and scoped OAuth records; preserve existing static configs, grants, connection IDs, and stdio/backend behavior.
2. Add the broker, bundled OAuth worker, validated lifecycle IPC, native scoped commit/cleanup and opener operations, and fixture tests before exposing UI.
3. Add Pen-derived local Settings states and explicit review; integrate broker-backed noninteractive credentials into runtime requests without changing replay policy.
4. Run focused protocol/native/UI/runtime tests, TypeScript checks, packaging/build checks, and user-performed native/Atlassian validation; record evidence and remaining limitations in `verification.md` during implementation.
5. Update setup docs and architecture/ADR guidance to distinguish OAuth support from unsupported grants/registration and backend limitations.

Rollback leaves outlines and agent references intact. Disable OAuth connections and remove their scoped authorization through the new implementation before returning to a version that does not support the descriptor; do not convert OAuth into a static token or downgrade validation. Existing manual/stdio/backend configurations remain usable.
