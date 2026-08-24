# ADR-0009: Keep Codex CLI for Subscription Image Generation

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** AI Chat project team
- **Supersedes:** None
- **Superseded by:** None

## Context

After replacing the `pi --mode rpc` CLI sidecar with an in-process Pi SDK (`ADR-0008` → `piSdkClient.ts`), the only remaining CLI dependency is `codex`, used exclusively for subscription-mode image generation. In subscription mode, `generate_image` spends the user's ChatGPT Plus/Pro image quota instead of billing the OpenAI platform API key.

We investigated whether `codex` could be removed by calling the internal ChatGPT image-generation endpoint directly, the way API-key mode already calls the public `https://api.openai.com/v1/images/generations`.

Inspection of the `codex` binary (a 220 MB Rust executable) revealed that subscription image generation is not a single HTTP call. The flow is:

1. `account/login/start` with `chatgptAuthTokens` (access token + `chatgptAccountId`).
2. Client attestation (`attestation/generate`, `RefreshAttestation`) proving the request originates from a legitimate client.
3. A full agent turn: a model receives an `$imagegen` instruction and invokes a built-in image-generation tool.
4. Requests to an undocumented `chatgpt.com/backend-api/` endpoint (the `codex-api/src/endpoint/images.rs` path).

The endpoint is private, undocumented, and protected by attestation machinery that exists specifically to prevent third-party use.

## Decision Drivers

- Remove process dependencies wherever they are redundant (already achieved for `pi`).
- Preserve subscription image generation as a supported billing path.
- Avoid fragile, silently-rotting reverse-engineered protocols.
- Respect OpenAI's terms of service and avoid account-suspension risk.
- Keep the attack surface small and the credential handling auditable.

## Considered Options

1. **Reverse-engineer the internal `backend-api` image endpoint** and call it directly with the ChatGPT OAuth token.
2. **Keep the `codex` CLI** as the subscription-mode bridge, isolated and sandboxed as today.
3. **Drop subscription image mode entirely**, keeping only API-key image generation.

## Decision

We will **keep the `codex` CLI as the subscription-mode image bridge** and will **not reverse-engineer the internal ChatGPT image endpoint**.

Subscription image generation remains a supported path, isolated exactly as before (ephemeral `CODEX_HOME`, read-only sandbox, no inherited secret env vars, shell/web/app/connector/memory/hook/multi-agent tools disabled, OAuth token over stdin, temp credential cache removed after each request).

## Consequences

### Positive

- Subscription image quota remains available without reimplementing proprietary auth.
- No exposure to undocumented endpoint breakage or ToS violations.
- `codex` continues to absorb OpenAI's auth, attestation, and protocol changes on our behalf.
- Credential handling remains bounded and auditable inside `codex-image-generation.ts`.

### Negative

- A 220 MB CLI binary remains a distribution and startup dependency.
- Distribution still requires bundling a pinned `codex` runtime (same requirement as before this decision).
- We cannot ship subscription image generation without the external binary.

### Risks and Mitigations

- **Risk:** `codex` CLI behavior changes and breaks the app-server RPC assumptions.  
  **Mitigation:** The RPC client already handles `ENOENT` and unexpected-exit errors with clear user-facing messages; the image tool is optional per-agent, so non-image agents are unaffected.

- **Risk:** The internal endpoint is tempting to reimplement later for a lighter binary.  
  **Mitigation:** This ADR records the decision against it; revisit only if OpenAI publishes a documented, supported subscription image API.

## Option Analysis

### Option 1: Reverse-engineer the internal `backend-api` endpoint

**Advantages**

- Removes the `codex` CLI dependency entirely.

**Disadvantages**

- Requires reimplementing client attestation, which is deliberate anti-abuse machinery.
- Depends on an undocumented endpoint that changes without notice.
- Risks OpenAI account suspension under the ToS.
- High ongoing maintenance burden for a feature that only some users exercise.

### Option 2: Keep the `codex` CLI as the subscription-mode bridge

**Advantages**

- Sanctioned, documented mechanism (`chatgptAuthTokens` login mode) for spending subscription quota.
- OpenAI maintains the auth, attestation, and protocol layers.
- Already isolated and audited in the current codebase.

**Disadvantages**

- Keeps a 220 MB binary as a dependency.
- Requires `codex` on PATH during development and a pinned bundled runtime for distribution.

### Option 3: Drop subscription image mode entirely

**Advantages**

- Removes `codex` completely; one billing model (API key only).

**Disadvantages**

- Removes a product capability that some users rely on (included image quota).
- Forces those users into API-key billing for images even when they subscribe.

## Implementation Notes

No code change. This ADR documents a deliberate non-change so future contributors understand why `codex` remains despite the SDK sidecar migration.

## Validation

- Subscription image generation continues to pass `codex-image-generation.test.ts`.
- The settings "Agent runtimes" panel reports Codex availability so users get a clear diagnostic when the binary is missing.
- Revisit if OpenAI ships a documented subscription image API or if usage data shows subscription image mode is unused.

## References

- `ADR-0008` — Pi RPC subprocess architecture (now superseded by the SDK sidecar).
- `src-tauri/resources/pi/sidecar/codex-image-generation.ts` — isolated Codex app-server image bridge.
- `src-tauri/resources/pi/sidecar/tools.ts` — `generate_image` tool and provider switch.
