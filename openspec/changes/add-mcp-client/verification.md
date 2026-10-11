# Verification

## Automatic approved-tool updates follow-up — 2026-09-30

ADR-0025 replaces definition-bound approval with stable connection/name/binding identities. Runs expose current validated definitions only for approved names; local refresh retains legacy IDs, disables removed tools, and leaves new tools ungranted. Definition-only updates no longer invalidate Settings/agent selections. OAuth account-change review and no external-action replay are unchanged.

- MCP host: `./node_modules/.bin/vitest run --config vitest.config.ts` in `packages/mcp-host`: **3 files, 41 tests passed**. Includes current-schema execution, newly appearing tool exclusion, stable IDs, legacy permission IDs, and changed-binding rejection for both new and legacy snapshots.
- Root: `./node_modules/.bin/vitest run packages/agent-runtime/src/mcp.test.ts apps/desktop/src/store/mcpStore.test.ts apps/desktop/src/components/Settings/McpSettings.test.tsx apps/desktop/src/components/Settings/AgentEditors.test.tsx apps/desktop/src/store/settingsMcpAccess.test.ts apps/server/src/mcp.test.ts apps/server/src/serverRunner.test.ts apps/desktop/src/agent/piGeneration.test.ts apps/desktop/src/agent/skillExecution.test.ts --exclude '**/.claude/**' --maxWorkers=3`: **9 files, 107 tests passed**.
- Sidecar: `./node_modules/.bin/vitest run mcp-management.test.ts run.test.ts mcp-oauth.integration.test.ts payload.test.ts --maxWorkers=2 --testTimeout=15000`: **4 files, 22 tests passed**, including scripted Pi execution against a changed schema and source/bundled management/OAuth fixtures. The first higher-concurrency run hit an existing 5-second management-fixture timeout; the lower-concurrency rerun passed without changing that test.
- TypeScript checks passed for agent-runtime, MCP host, desktop, and sidecar. The normal server check is blocked by the existing `Headers` iterable typing at `packages/mcp-host/src/oauthFetch.ts:62`; the server configuration omits `DOM.Iterable`. The diagnostic server check with `--lib ES2022,DOM,DOM.Iterable` passed, but is not a clean normal server gate.
- Sidecar `node build.mjs` and desktop `vite build` passed, with existing dependency annotation/chunk-size warnings. Strict OpenSpec validation passed for `add-mcp-client`, `add-local-mcp-oauth`, and `redesign-settings`; `git diff --check` passed.
- No native/browser session or live provider call was performed. Local legacy approvals require no renewed selection. Backend upgrades from the old definition-hashed IDs need one initial selection of the new stable IDs; later definition updates/restarts preserve them.

Verified on 2026-09-27.

## Passed checks

- `openspec validate add-mcp-client --strict`.
- Desktop and server TypeScript checks: `tsc -p apps/desktop/tsconfig.json --noEmit` and `tsc -p apps/server/tsconfig.json --noEmit`.
- `pnpm --filter @forage/mcp-host test`: 6 tests. Covers real stdio subprocess discovery and calls, HTTP header authentication, tool authorization and definition changes, schema validation, secret handling, cancellation, and waiting for subprocess cleanup.
- `pnpm --filter @forage/pi-runtime test`: 48 tests, including schema preservation through the Pi tool adapter.
- `pnpm --filter forage-sidecar build` and `pnpm --filter forage-sidecar test --maxWorkers=2`: build succeeded; 29 tests passed. Tests exercise both source and bundled MCP discovery entry points and a scripted Pi turn calling a fixture MCP server.
- Targeted root Vitest run with `--maxWorkers=2`: 184 tests across 21 files passed. Selected MCP store/settings, agent/settings panels, local runner/generation/SDK client, backend MCP configuration/inventory, backend runner/store/API, and shared contract suites. Includes backend execution through a fixture MCP server and a scripted model.
- PostgreSQL MCP lease-recovery contract test: 1 passed, 53 unrelated tests skipped. Ran against the dedicated `forage_contract_test` database, separate from development data.
- Full native `cargo test`: 42 tests passed. After adding the MCP credential-reference regression case, `cargo test local_credential_reference_tests` passed all 3 cases and compiled the native crate successfully.
- `git diff HEAD --check`.

## Limits of verification

An initial broad root suite was interrupted after concurrent test processes caused subprocess timeouts. The affected sidecar suite and the targeted root suites subsequently passed with lower concurrency; this is not a claim that the full root suite passed.

No manual desktop UI session or external production MCP service was used. Protocol execution was verified with local stdio and HTTP fixtures; model calls were scripted. Interactive OAuth, legacy HTTP+SSE, resources, prompts, sampling, elicitation, and MCP apps are outside this change. See `docs/mcp.md` for setup and supported behavior.

## Connection experience follow-up

Added URL/token and launch-command forms, optional named credential fields, and advanced JSON import. MCP Settings and the agent picker now resolve the same persisted mode as skill execution automatically. Backend failures do not expose local connections or a local setup form.

- Targeted settings, command-parser, and store Vitest run: 59 tests across 7 files passed.
- Store suite rerun after adding the native credential-size guard: 6 tests passed.
- Desktop TypeScript check, strict OpenSpec validation, and `git diff HEAD --check` passed.
- UI tests cover URL/token submission, quoted command arguments and environment values, credential clearing, failed connection recovery, JSON import, tool enablement, mode-read failure, backend retry, and matching backend inventory in the agent picker. Command tests cover literal quoting/escaping and rejected shell syntax.
- No browser or manual native UI session was used for this follow-up. Backend provisioning remains operator-owned.

## Existing-client discovery follow-up

Added read-only discovery of user-level MCP configuration in Codex, Claude Desktop, Claude Code, Cursor, and VS Code. Connection imports re-read the source, prompt for unavailable values, copy configuration into Forage's vault, and lead into explicit tool and agent access review. Advanced setup is retained. Registry browsing, bundles, install links, OAuth, and device-to-backend routing remain out of scope.

- MCP host suite: 12 tests passed, including TOML/JSONC parsing, exact-definition deduplication, sanitized candidate output, credential resolution, source-change rejection, unsupported/disabled settings, limits, and the existing transport tests.
- Sidecar build and full suite: 31 tests passed across 9 files. Both source and packaged management entry points scan fixture configuration without executing its nonexistent command, resolve the selected configuration on request, and reject changed source definitions.
- Targeted desktop settings and store suites: 52 tests passed across 7 files. Final discovery UI, import, permission, and shared contract checks after UI refinements: 47 tests passed across 5 files. These runs overlap.
- Desktop and server TypeScript checks, strict OpenSpec validation, and whitespace checks passed.
- A read-only scan of the actual machine found Pen entries from Codex and Claude Code. Their differing launch arguments produced separate candidates; no Pen process was launched, connection saved, source file changed, or tool permission granted by this check.
- No browser or manual native UI session was used. A pnpm registry verification failure inside the network sandbox was retried successfully with approved registry access.
