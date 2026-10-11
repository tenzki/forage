# Local MCP OAuth verification

Date: 2026-09-30. Implementation and automated verification are complete. The user confirmed successful Jira use through the live Atlassian v2 connection; the remaining native and provider lifecycle acceptance checks keep tasks 6.3 and 6.4 open. No Computer Use, GUI automation, agent-operated browser, or agent-performed provider consent was used.

## Automated gates

### Follow-up: hostname DNS failure

Investigation of the first user-reported failure reproduced a network error before browser consent. A public metadata-only request through Forage's constrained fetch reproduced `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` on Node 26.8.1. Node's automatic address-family selection requests DNS results with `all: true`; the pinned lookup callback incorrectly returned the single-address signature. It now returns a one-element validated address array for that mode, retaining the same DNS pinning and private-address policy.

Two regression cases force automatic family selection off/on with a hostname fixture. Before the fix, the enabled case failed with the same error; afterward both pass. Source and bundled interactive fixtures now use `localhost` and explicitly enable Node family selection. Follow-up verification:

- MCP host suite: 3 files, 38 tests passed (26 OAuth cases).
- Source/bundled sidecar suite: 4 files, 21 tests passed.
- MCP host and sidecar TypeScript checks, `node build.mjs`, and `git diff --check`: passed.
- Read-only requests through the fixed fetch successfully retrieved Atlassian metadata (HTTP 200) and completed SDK discovery of the v2 resource's advertised authorization server, public registration endpoint, S256 and public-client authentication support. No client was registered and no authorization/consent/token request was performed; tasks 6.3/6.4 remain pending.

### Follow-up: unused public-client registration secret

The user reported that checking browser sign-in support disappeared without opening the browser for `https://mcp.atlassian.com/v2/mcp`. Live SDK discovery and registration reproduced the cause: Atlassian returns a client secret even when the registered `token_endpoint_auth_method` is `none`. Forage now discards that unused secret and its expiry metadata only when public-client authentication is explicit. Registrations that require confidential-client authentication, or return a secret without confirming `none`, remain unsupported. The discarded secret is neither persisted nor used for code exchange or refresh.

Follow-up commands run from the repository root:

| Command | Result |
| --- | --- |
| `pnpm --filter @forage/mcp-host test` | 3 files, 44 tests passed, including public-client secret disposal, secret-free exchange/refresh, and rejection of confidential or ambiguous registrations. |
| `pnpm --filter @forage/mcp-host typecheck` | Passed. |
| `pnpm --filter forage-sidecar build` | Passed. |
| `node apps/desktop/scripts/sync-dev-sidecar.mjs` | Refreshed the development app's bundled worker resources. |
| `pnpm --filter forage-sidecar test mcp-oauth.integration.test.ts` | 1 file, 8 tests passed, including source/bundled public registration with an unused secret. |
| `pnpm --filter forage-sidecar typecheck` | Passed. |

A command-line check of the refreshed development worker reached the live Atlassian v2 authorization URL and was deliberately cancelled before browser launch or consent. Subsequently, the user completed their own sign-in and confirmed Jira works; see the acceptance record below.

The original implementation gate results follow.

Commands use installed executables because pnpm's signature verification attempted unavailable network access. Paths below are relative to the stated working directory. HTTP/loopback fixtures and native tests were run with approved execution outside the filesystem sandbox; the sandbox initially denied fixture listeners with EPERM.

| Working directory | Command | Result |
| --- | --- | --- |
| Repository root | `./node_modules/.bin/vitest run apps/desktop/src/store/mcpStore.test.ts apps/desktop/src/components/Settings/McpSettings.test.tsx apps/desktop/src/agent/mcpOAuthClient.test.ts apps/desktop/src/agent/piSdkClient.test.ts apps/desktop/src/agent/piGeneration.test.ts --exclude '**/.claude/**' --maxWorkers=3` | 5 files, 77 tests passed. Final run excludes an unrelated nested worktree. |
| `packages/mcp-host` | `./node_modules/.bin/vitest run --config vitest.config.ts` | 3 files, 36 tests passed, including 24 OAuth cases. |
| `apps/desktop/src-tauri/resources/pi/sidecar` | `./node_modules/.bin/vitest run mcp-oauth.integration.test.ts run.test.ts payload.test.ts mcp-management.test.ts` | 4 files, 21 tests passed, including 6 source/bundled OAuth worker cases. |
| Repository root | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 54 tests passed, including 8 OAuth native ownership/commit tests. |
| Repository root | `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` | Passed. |
| Repository root | `./node_modules/.bin/tsc --noEmit -p apps/desktop/tsconfig.json` | Passed. |
| Repository root | `./node_modules/.bin/tsc --noEmit -p apps/desktop/src-tauri/resources/pi/sidecar/tsconfig.json` | Passed. |
| Repository root | `./node_modules/.bin/tsc --noEmit -p packages/mcp-host/tsconfig.json` | Passed. |
| `apps/desktop/src-tauri/resources/pi/sidecar` | `node build.mjs` | Passed; includes the dedicated `mcp-oauth.mjs` entry. |
| `apps/desktop` | `../../node_modules/.bin/tsc -p tsconfig.json && ./node_modules/.bin/vite build` | Passed. Existing annotation, dynamic/static import and chunk-size notices remain nonfatal. |
| Repository root | `openspec validate add-local-mcp-oauth --strict --no-interactive` | Passed. |
| Repository root | `git diff --check` | Passed. |

## Verified boundaries

- Legacy static headers, no-auth, stdio and server configuration retain their prior meaning. OAuth/None reject custom Authorization; explicit registration options are mutually exclusive and OAuth is local-only.
- Fixture metadata covers OAuth and OIDC discovery, issuer mismatch, unsupported public registration, pre-registered public IDs, explicit metadata URLs, private-network injection, redirect rejection and bounded response sizes. MCP headers are not forwarded to authorization services.
- Successful public registration uses the exact ephemeral loopback redirect, fresh state and PKCE S256. Wrong state/path, missing or wrong required issuer, provider denial, replay, cancellation and expiry cannot exchange a second code or leave a live listener.
- Source and bundled workers complete fixture authorization/discovery and noninteractive refresh without model calls. Progress excludes access/refresh tokens; malformed requests and provider failures return fixed sanitized errors. Child environment is restricted to the MCP worker allowlist.
- Native leases enforce connection/resource/issuer, generation and version boundaries. Cancellation/disconnect and stale writes fail closed; injected SQLite failure rolls back credential/configuration commit. Refresh rotation is persisted before release, omitted replacements survive, and a durable pending marker prevents replay after an ambiguous exchange or restart.
- Broker tests cover serialization, cancellation during lease acquisition, access-token-only run resolution, persistence failure, and review-revision admission. Private token messages are intercepted before ordinary activity routing. Interactive reauthentication cannot switch an already admitted run to another account.
- Mutation fixtures assert exactly one external call for HTTP 401, 403 and 500, transport disconnection and cancellation. No SDK unauthorized hook or automatic turn replay is introduced. Invalid/missing refresh requires explicit sign-in; transient errors do not delete credentials.
- Token-bearing tool output is redacted; credential-bearing tool names/schemas are rejected. Tokens, refresh credentials, callback codes and verifier do not enter portable connection metadata or ordinary progress/activity.
- Store and UI tests cover independent Browser/Manual/None drafts, waiting/cancel controls, failed-new-connection rollback, no consent-derived grants, explicit access review after reauthentication, preservation of unchanged saved selections, read-only sign-in-required permissions and disconnect.

## Broader-suite limitations

The root suite is not reported as clean:

- `./node_modules/.bin/vitest run --maxWorkers=3` discovered unrelated tests under `.claude/worktrees/debug-relevant-placement/` with unavailable build/fixture dependencies and PostgreSQL contract tests whose configured `127.0.0.1:55437` service was down. Result: 276 files passed, 10 failed; 2,016 tests passed, 18 failed, 60 skipped. No unrelated worktree or database setup was changed.
- A broader scoped run, `./node_modules/.bin/vitest run apps/desktop/src/ packages/agent-runtime/src/ apps/server/src/ packages/protocol/src/ packages/domain/src/ packages/document/src/ --exclude '**/.claude/**' --exclude '**/postgres.test.ts' --maxWorkers=3`, passed 142 files and 1,091 tests but timed out one existing `App.test.tsx` persistence-retry test. Its isolated rerun, `./node_modules/.bin/vitest run apps/desktop/src/App.test.tsx -t 'keeps fresh edits behind an in-flight persistence retry'`, passed (2 matching files, 2 tests passed, 71 skipped, including the nested worktree). OAuth changes do not modify this persistence-retry behavior; the full-suite timing failure remains recorded rather than silently counted as a pass.

## Pending user acceptance — task 6.3

Start the real local-only app with `pnpm dev:desktop`. In Settings → MCP servers, verify:

- Browser setup `stRd6`, waiting `qJgcM`, review `mcOhA`, failure `vE4Au`, sign-in required `ZHz9y` and manual `rawFS` against the Pen handoff, including spacing and actual discovered labels.
- System-browser launch and return, Open browser again using the same request, clipboard recovery, keyboard navigation and focus/status announcements.
- Cancellation, leaving setup, changing authentication/workspace mode, app exit and restart; late callbacks must not save a connection or resurrect removed authorization.
- Existing manual Bearer/custom-header, None, command and JSON-import configurations remain usable without implicit sign-in.
- Initial consent enables no tools. After interactive reauthentication (including another account/site), unchanged selections remain drafts and execution stays unavailable until Save access.

No native visual or clipboard check has been claimed as passed.

## Pending Atlassian acceptance — task 6.4

User acceptance recorded on 2026-09-30:

- [x] Initial live Jira use: the user selected a workspace during browser consent, the saved connection showed connected status and discovered tools, and the user subsequently reported **"Jira works"**. This establishes successful initial OAuth completion and an admitted Jira query through `https://mcp.atlassian.com/v2/mcp` with Forage's public-client flow. It does not establish a specific ticket count or query result.
- The earlier missing-cloudId response was traced to saved permissions: `getAccessibleAtlassianResources` was disabled globally and absent from the General assistant's tool selection. The user was instructed to enable it, plus `discover` and `executeRead` for board-specific operations. OAuth site consent and Forage tool grants remain separate.
- [ ] Silent refresh after token expiry and saved authorization after app restart.
- [ ] Interactive reauthentication, including different-account/site review, retaining selections as drafts and requiring Save access before execution.
- [ ] Disconnect and rejection of late authorization results.

Task 6.4 remains open until the remaining lifecycle checks are observed. Record any provider or administrator restrictions. Do not borrow another client's identity or assume fixture success proves untested provider behavior. Task 6.3's native visual, clipboard, recovery, cancellation, keyboard and compatibility checks also remain pending.

Documentation records public-client/grant limits, native SQLite storage limitations, consent versus tool grants, local-only ownership, refresh ambiguity and no-replay recovery in `docs/mcp.md`, `docs/settings.md`, `docs/architecture.md` and ADR-0024.
