## 1. Define authentication and lifecycle contracts

- [x] 1.1 Add backward-compatible local HTTP authentication descriptors and sanitized authorization/review statuses; verify schema tests preserve legacy header/no-auth, stdio, import, and backend configurations and reject conflicting credentials.
- [x] 1.2 Define bounded authorization-job, scoped credential-reference, broker request/result, generation/version, and noninteractive run credential contracts; verify secret-bearing fields cannot enter metadata, ordinary activity, portable configuration, or diagnostics.
- [x] 1.3 Document the supported public-client registration/grant policy and authentication state transitions, including explicit post-reauthentication review; verify each state and limit maps to the spec and Pen handoff without unresolved implementation-changing decisions.

## 2. Build the shared OAuth protocol worker

- [x] 2.1 Add fixture-backed protected-resource and OAuth/OIDC metadata discovery with SDK validation, HTTPS/loopback policy, response limits, and scoped fetch behavior; verify malformed issuers, private-network injection, redirects, secret forwarding, and oversized responses are rejected.
- [x] 2.2 Add supported dynamic/public-client registration and advanced explicit client ID/metadata URL configuration; verify issuer/resource-bound registrations, missing support, scope selection, and truthful unsupported-grant errors without a provider preset or borrowed identity.
- [x] 2.3 Add Authorization Code + PKCE S256 and a bound one-shot loopback callback; verify state/issuer/path mismatch, required missing issuer, replay, provider error, exact registered redirect, and successful token exchange with fixture servers.
- [x] 2.4 Add the cancellable dedicated OAuth worker and bounded lifecycle messages, a five-minute interactive deadline, browser recovery URL, and final discovery result; verify timeouts, early exits, late callbacks, process/listener cleanup, and exclusion of secrets from messages/errors.

## 3. Add native ownership, commit, and refresh coordination

- [x] 3.1 Add narrow native scoped credential/job operations and application-owned broker coordination for management and run sidecars; verify reference validation, connection/issuer/resource isolation, access-token-only run resolution, and rejected stale job/generation/version writes.
- [x] 3.2 Add atomic staging/completion of new authorization, credential/metadata persistence, and failed/cancelled-job cleanup; verify storage/discovery failures never report a connected server or leave usable staged credentials and preserve unrelated connections.
- [x] 3.3 Add the explicit validated system-browser opener and active-link recovery integration with native worker packaging/capabilities; verify arbitrary URL/command rejection, exact job binding, and source/bundled management behavior without opening a browser in automated tests.
- [x] 3.4 Add serialized pre-request refresh and durable rotation; verify concurrent management/runs share committed results, missing replacement refresh tokens are preserved, persistence failure fails closed, and ambiguous exchanges are not replayed.
- [x] 3.5 Add disconnect, cancel, workspace-mode/app-exit cleanup, bounded best-effort revocation, and generation invalidation; verify late sign-in/refresh cannot resurrect removed credentials or grants, and remote revocation failure cannot prevent local removal.

## 4. Integrate local run authorization without replay

- [x] 4.1 Resolve OAuth credentials through the broker for admitted local MCP sessions using a noninteractive per-request token provider; verify endpoint/resource/issuer and permission snapshots remain enforced and no run starts a browser/listener or accesses refresh credentials directly.
- [x] 4.2 Disable SDK unauthorized-request replay and retain insufficient-scope throw and existing turn retry limits; verify mutation fixtures receive exactly one call on 401, 403, transport failure, cancellation, and worker/provider errors.
- [x] 4.3 Surface typed sign-in/review-required versus transient connection failures and keep saved permissions unavailable until recovery/review; verify invalid grants, missing refresh, outages, and explicit new runs do not silently reset grants or replay old work.
- [x] 4.4 Revalidate inventories after interactive reauthentication and preserve the connection identity and unchanged saved selections as a draft awaiting Save access; verify different-account safety, changed/new definitions, cancelled review, and refresh-only stable tool IDs.

## 5. Implement Pen-aligned Settings states

- [x] 5.1 Implement `stRd6` Browser sign-in setup and `rawFS` manual fallback with three independent authentication drafts, None behavior, and existing command/JSON paths; verify method-specific submission, conflict validation, dirty exit, no implicit OAuth migration, and local/server routing.
- [x] 5.2 Implement `qJgcM` waiting, frozen fields, Open browser again, Copy sign-in link, cancellation, and accessible status/focus; verify recovery reuses one request, navigation/mode changes cancel it, late events are ignored, and links are not persisted/logged.
- [x] 5.3 Implement `vE4Au` denied/expired/failed and unsupported-sign-in states with sanitized specific reasons and explicit fresh retry; verify drafts persist, unsupported methods are never silently selected, and failed new setup grants/saves nothing.
- [x] 5.4 Implement `mcOhA` successful connection review through existing tool/agent permission services; verify initial unchecked choices, global-only/additive grants, independent description expansion, actual discovered labels, and cancellation retaining the ungranted connection.
- [x] 5.5 Implement `ZHz9y` Sign-in required and post-reauthentication review statuses with read-only saved permissions and explicit Sign in again; verify scope escalation, changed inventory, unavailable tools, no automatic browser actions, and server-mode absence.

## 6. Verify integration and document support

- [x] 6.1 Run integrated source/bundled worker, protocol, callback, vault/native, rotation, IPC, store/UI, and local run tests; record exact commands/results in this change's `verification.md`, including secret-redaction and exactly-once external-call assertions.
- [x] 6.2 Run affected TypeScript checks, sidecar/desktop packaging builds, relevant Rust checks, and `openspec validate add-local-mcp-oauth --strict --no-interactive`; record results and resolve failures attributable to this change without changing unrelated work.
- [ ] 6.3 Have the user verify real native/system-browser start/return, clipboard recovery, keyboard/focus, cancel/exit/restart, manual/no-auth/command compatibility, and the six Pen states; record observed outcomes or pending manual checks without Computer Use or browser automation.
- [ ] 6.4 Have the user verify Forage's own public-client registration, exact loopback callback, consent, tool discovery, explicit grants, reauthentication, and disconnect against Atlassian's hosted MCP endpoint; record administrator/provider limitations without impersonation or claiming untested compatibility.
- [x] 6.5 Update MCP setup/limits, Settings guidance, architecture and credential/lifecycle ADR documentation; verify they distinguish consent from grants, manual Bearer from custom Authorization, registration limits, no-replay recovery, and local-only/backend ownership.
