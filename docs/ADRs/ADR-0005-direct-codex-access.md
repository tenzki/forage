# ADR-0005: Access OpenAI Codex Directly from the Desktop Frontend

- **Status:** Accepted
- **Date:** 2026-08-14
- **Deciders:** AI Chat project team
- **Supersedes:** None (replaces undocumented direct-Anthropic and Node-sidecar approaches)
- **Superseded by:** None

## Context

AI generation is a core desktop feature, but v1 has no hosted application backend. A previous design introduced a packaged Node.js sidecar to host an agent SDK, adding process lifecycle, RPC, binary size, signing, and notarization concerns. A later direct-Anthropic implementation reduced those seams but supported only pasted API keys and a different model family.

The current implementation uses the provider interfaces in `@earendil-works/pi-ai` and supports Codex through either a ChatGPT subscription device login or a user-provided OpenAI API key. Tauri's HTTP plugin performs requests without webview CORS restrictions.

## Decision Drivers

- No managed inference proxy or application server in v1.
- Support both ChatGPT subscription login and user-provided OpenAI API keys.
- Stream model output into the editor.
- Avoid a packaged Node.js sidecar.
- Keep model selection and tool-call messages typed.

## Considered Options

1. **Direct Codex/OpenAI access from the frontend** — use Pi AI provider adapters and Tauri HTTP transport.
2. **Hosted application proxy** — send prompts through an AI Chat backend.
3. **Packaged Node.js sidecar** — run the provider or agent SDK in a child process.
4. **Direct vendor SDK with API key only** — call one provider directly without subscription OAuth.

## Decision

We will **call OpenAI Codex directly from the desktop frontend through `@earendil-works/pi-ai`, using Tauri HTTP as the transport** because **this supports streaming and two user-owned authentication modes without adding an application server or sidecar**.

Subscription mode uses OpenAI's device authorization flow and refresh tokens. API-key mode uses the user's OpenAI key. Credentials and the selected model are stored locally through Tauri Store. The application does not proxy prompts or credentials through infrastructure operated by this project.

## Consequences

### Positive

- There is no inference backend to deploy, operate, or bill.
- Users can use either an eligible ChatGPT subscription or their own API account.
- Provider streaming integrates directly with editor updates.
- Pi AI supplies typed provider, model, message, and tool-call abstractions.
- Sidecar packaging and RPC are eliminated.

### Negative

- Provider credentials are available to trusted frontend code.
- Tauri Store is local persistence, not a guaranteed OS-keychain security boundary.
- The client depends on provider-specific OAuth endpoints and behavior.
- Provider requests and errors must be handled in the desktop app.
- Supporting another provider requires explicit product and compatibility work.

### Risks and Mitigations

- **Risk:** Stored access, refresh, or API tokens are exposed from local settings.  
  **Mitigation:** Never log or place credentials in model-visible messages; evaluate migration to an OS keychain before broader distribution.
- **Risk:** OpenAI changes its device authorization or Codex protocol.  
  **Mitigation:** Isolate authentication in `codexAuth.ts`, provider selection in `client.ts`, and cover response validation and refresh behavior with tests.
- **Risk:** Broad HTTP capability grants unnecessary destinations.  
  **Mitigation:** Keep Tauri's HTTP allowlist limited to the provider and separately accepted tool origins.
- **Risk:** Subscription and API-key models diverge in capability.  
  **Mitigation:** Resolve models per provider mode and fall back only to models advertised by that provider.

## Option Analysis

### Option A: Direct Codex/OpenAI Access from the Frontend

**Advantages**

- Few deployment components and immediate streaming.
- Supports user-owned authentication without project infrastructure.
- Reuses the thin-Tauri architecture.

**Disadvantages**

- Places authentication and request orchestration in trusted frontend code.
- Depends on provider APIs and Tauri HTTP permissions.

### Option B: Hosted Application Proxy

**Advantages**

- Credentials and provider adaptation can be centralized.
- Enables policy, telemetry, quotas, and managed billing.

**Disadvantages**

- Adds hosting, accounts, privacy obligations, and operational cost.
- Contradicts the local-first, user-funded v1 scope.

### Option C: Packaged Node.js Sidecar

**Advantages**

- Can run Node-only SDKs outside the webview.
- Offers a process boundary for agent orchestration.

**Disadvantages**

- Adds RPC, lifecycle, binary-size, signing, and notarization complexity.
- Reintroduces a runtime seam removed by ADR-0001.

### Option D: Direct Vendor SDK with API Key Only

**Advantages**

- Simple authentication and a small integration surface.
- Uses documented API billing flows.

**Disadvantages**

- Excludes users who want to use an eligible ChatGPT subscription.
- Provides less abstraction for model and tool message formats.

## Implementation Notes

`src/agent/codexAuth.ts` owns device login, token exchange, JWT account extraction, and refresh. `src/agent/client.ts` selects the Pi AI provider and model, injects Tauri HTTP as `fetch`, and streams events. `src/store/settingsStore.ts` persists authentication mode, credentials, and model selection.

Prompt or response logging must redact credentials. Any move to hosted inference, another privileged process, or project-managed credentials requires a superseding ADR.

## Validation

- Device login succeeds, survives restart, and refreshes before expiration.
- API-key mode fails clearly when no key is configured and streams when a valid key is present.
- Selected models are constrained to those supported by the active provider mode.
- Cancellation aborts active provider and authentication requests.
- Tests confirm credentials never appear in prompt context, tool definitions, tool results, or error logs.
- The packaged Tauri app reaches only capability-allowed provider endpoints.

## References

- `src/agent/client.ts`
- `src/agent/codexAuth.ts`
- `src/store/settingsStore.ts`
- `src/components/Settings/SettingsPanel.tsx`
- `src-tauri/capabilities/default.json`
- `package.json`
