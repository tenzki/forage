# Redesign settings verification

## Remaining Pen presentation correction (2026-09-30)

Inspected the remaining reference screens through the Pencil API and content-frame screenshots, without modifying the designs or using Computer Use/browser automation: Diagnostics `aP053`, provider setup `KkS17`, Agents `eDZqs`, agent editor `o4cSYt`, Extensions `xttSQ`, generic extension details `x7roQ`/`iO4yZ`, and MCP URL/command setup `mYqK6`/`i7FjPu`.

- Diagnostics now uses grouped icon/status rows, paired check/report actions, and divided technical details. Entry shows **not checked** and performs no probes. The seven existing independent checks remain truthful; no MCP/image-generation connectivity checks or live entitlement verification were invented.
- Provider setup has its own heading, full-width provider selection, divided selected-provider setup, and paired Connect/Cancel actions. Overview/default controls remain absent while editing. Credentials, cancellation, account authority, and explicit default selection are unchanged.
- Agents/Skills/Tools use 36 px group spacing and bordered inventories rather than legacy section dividers. Add/restore skill actions share a row. Agent/skill editors use unboxed 24 px spacing and 120 px instructions. Ordinary tools have compact source labels and retained unavailable reasons; inherited compute is a plain summary/link. MCP access remains individually reviewed and draft-only. Existing Inbox rule behavior and server-only availability are unchanged.
- Extensions inventory uses paired notices, compact heading actions, count badges, and manifest descriptions. The shared detail template has a generic identity icon, separate metadata, divided tools/skill/lifecycle sections, compact agent/executor rows, and no redundant nested Back action. Tool-free extensions omit unnecessary Agent access. Access still opens the ordinary guarded agent editor instead of instant grants; trust, readiness, source configuration, unavailable executors, lifecycle controls, and sanitized diagnostic copying are retained.
- MCP setup places segmented method controls before server fields, pairs Connect/Cancel, and moves collapsed JSON below the actions with visible guidance. Command setup shows equal-width environment fields without treating the initial empty pair as dirty. Method-specific drafts/payloads, credential clearing, command/download warnings, dirty exits, and explicit post-connection access review remain covered.

### Current-source evidence

- Focused Settings suite: **13 files, 130 tests passed**. `./node_modules/.bin/vitest run apps/desktop/src/components/Settings --exclude '**/.claude/**' --reporter=dot`.
- Regression suite: **141 files passed, 1 skipped; 1055 tests passed, 36 PostgreSQL tests skipped**. `TEST_DATABASE_URL= ./node_modules/.bin/vitest run apps/desktop/src apps/server/src packages/agent-runtime/src packages/protocol/src packages/domain/src packages/document/src --exclude '**/.claude/**' --exclude '**/src-tauri/**' --reporter=dot`. The sandboxed attempt encountered stream-fixture `listen EPERM` and a timing-sensitive App trash assertion; the approved localhost-capable rerun passed without changing unrelated tests. Existing React act/fixture warnings remain nonfatal.
- `pnpm --filter @forage/desktop build` passed, including TypeScript and production CSS compilation. Approved registry access was required for pinned pnpm verification. Existing dependency-annotation, dynamic-import, and chunk-size warnings remain nonfatal.
- `./node_modules/.bin/tsc -p apps/desktop/tsconfig.json --noEmit`, strict OpenSpec validation, and `git diff --check` passed.
- Added deterministic evidence for scoped editor/list cascade overrides, generic detail typography/dividers, source-row presentation, unchecked diagnostics, provider setup structure, segmented MCP action placement, empty command-draft cancellation, and cleared environment credentials. These tests assert CSS declarations/DOM/behavior, not native geometry.

No persistent runtime, native visual/restart check, browser, live provider call, or PostgreSQL contract database was used. Unrelated staged/onboarding/design changes remain untouched. Manual native comparisons, behavior/design reconciliation, and final capability review remain tasks 6.3/6.5/6.6; this change is not archived or marked fully verified.

## Pen presentation correction (2026-09-30)

Following the user's mismatch report, the live Pencil connector was available again. Screens `uFKHO`, `UVrNy`, `yD3fN`, and `SOQOK` were explicitly prioritized and inspected through node properties and Pencil screenshots, including their content frames. No design data was changed to make it resemble the implementation. Earlier functional tests did not establish visual fidelity.

The shared layout had a real cascade defect: new Settings rules were inside `@layer components`, while legacy settings rules were unlayered and therefore won regardless of selector specificity. This retained the old centered/narrow panel, heading sizes, card padding, and stacked form presentation. Scoped, unlayered `settings.css` now owns Settings presentation without changing other secondary pages. It follows the Pen's left-aligned 180 px nav, 48 px gap, up-to-640 px content, 40/56 px top/side padding, and adds container-width responsive layouts.

- `uFKHO`: grouped appearance rows with segmented System/Light/Dark controls, compact font/size controls, a labeled static nested preview, Accessibility, automatic-save hint, and Support/version/Diagnostics. Theme choices remain disabled before hydration.
- `UVrNy`: provider/add actions share the heading row, accounts share a compact bordered list, paired default controls show the saved selection, and Workspace connection follows defaults without the old enclosing card. Defaults still require explicit Save; unavailable selections remain inspectable, never reset or silently repaired. Provider setup/management remains explicit and hides overview controls while editing.
- `yD3fN`: Add server is beside the overview heading; connected and detected inventories use neutral 40 px plug tiles, compact summary/action rows, separated discovery, and setup guidance. Required credentials, independent same-name definitions, rename controls, sanitized failures, and trust warnings remain available.
- `SOQOK`: connection identity/status and source information precede Tools; Refresh is aligned with its heading; tool names/descriptions occupy one-line preview columns with independent chevron disclosure and authorization switches. Agent selections use explicit checkbox cards and a staged-access summary. The existing additive-grant semantics and Cancel/save/publication/fingerprint guards are preserved, rather than implementing the mockup's misleading exclusive-access sentence.

Evidence: the final focused Settings suite passed **13 files, 123 tests**, including CSS cascade assertions against representative legacy unlayered rules, General grouping/hydration, Connection order/current defaults, keyboard disclosure independence, and agent choice staging without grants. Command: `./node_modules/.bin/vitest run apps/desktop/src/components/Settings --exclude '**/.claude/**' --reporter=dot`.

Current-source regression passed **141 files, 1 skipped; 1048 tests passed, 36 skipped** using `TEST_DATABASE_URL= ./node_modules/.bin/vitest run apps/desktop/src apps/server/src packages/agent-runtime/src packages/protocol/src packages/domain/src packages/document/src --exclude '**/.claude/**' --exclude '**/src-tauri/**' --reporter=dot`. PostgreSQL was intentionally disabled; no live credentials or third-party connections were used. The desktop production build and TypeScript checks passed. jsdom checks CSS declarations/cascade and interactions, not native geometry, contrast, or rendered screenshots. Real Tauri visual observation remains manual under the Computer Use prohibition, and tasks 6.3/6.5/6.6 remain open.


## Integrated verification: task group 6 (2026-09-30)

Tasks 6.1, 6.2, and 6.4 have automated evidence below. Tasks 6.3, 6.5, and 6.6 remain open: native manual observation and final design reconciliation are not complete, so this change must not be archived. Earlier sections are historical stage reports, not the current completion status.

### Commands and results

- Final focused Settings/store/provider/native-adapter run: `./node_modules/.bin/vitest run apps/desktop/src/components/Settings apps/desktop/src/store/settingsMigration.test.ts apps/desktop/src/store/settingsStoreMigration.test.ts apps/desktop/src/store/settingsReleaseCompatibility.test.ts apps/desktop/src/store/providerConnections.test.ts apps/desktop/src/store/mcpStore.test.ts apps/desktop/src/store/settingsMcpAccess.test.ts apps/desktop/src/agent/localCredentials.test.ts packages/agent-runtime/src/providers.test.ts packages/agent-runtime/src/provider-validation.test.ts packages/protocol/src/providerContracts.test.ts --exclude '**/.claude/**' --reporter=dot`: **22 files, 191 tests passed**, including four release-compatibility tests.
- Live contracts: `TEST_DATABASE_URL='postgres://forage:forage@127.0.0.1:55437/forage_contract_test' ./node_modules/.bin/vitest run apps/server/src/postgres.test.ts --exclude '**/.claude/**' --reporter=dot`: **36 tests passed**. The fresh dedicated database applied migrations through `0007_model_providers.sql`. The suite now refuses database names other than `forage_contract_test`, in addition to the existing development-URL guard. The development database and unrelated containers were not used by destructive tests.
- Current-source regression: `TEST_DATABASE_URL='postgres://forage:forage@127.0.0.1:55437/forage_contract_test' ./node_modules/.bin/vitest run apps/desktop/src apps/server/src packages/agent-runtime/src packages/protocol/src packages/domain/src packages/document/src --exclude '**/.claude/**' --exclude '**/src-tauri/**' --reporter=dot`: **140 files, 1068 tests passed**, including the live contracts and release fixtures. Approved execution allowed existing localhost socket tests. React act warnings and expected sanitized fixture failures remain nonfatal.
- `pnpm test:extensions`: **16 workspace tasks successful, 248 tests across eight suites passed** (eight tasks cached), covering Pi runtime, packaged sidecar, extension host/API, MCP host, and reference/image/System One extensions.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: **46 tests passed**, including native credentials, origin pinning, SQLite persistence, assets, and sessions.
- `pnpm build`: **11 workspace tasks successful** (nine cached), including desktop/server/shared/sidecar builds and TypeScript checks. Existing dependency annotations, dynamic imports, chunk size, and Turbo output warnings remain nonfatal.
- `pnpm --filter @forage/desktop exec tauri build --debug --bundles app --config /private/tmp/forage-settings-qa.json`: successful actual native bundle build with isolated identifier `com.forage.settings-qa`. Launching that bundle is not visual verification; no interactive assertions or restart checks passed. The normal application profile was not used for QA.
- `openspec validate redesign-settings --strict --no-interactive`: passed. Validation establishes schema consistency, not completion of manual requirements.
- Additional `node --test scripts/*.test.mjs`: **7 passed, 1 failed**. The existing System One boundary check flags `app.forage.system-one` in `apps/desktop/src/components/ui/UiGallery.tsx`; the identical string is present in `HEAD` and that file is unchanged by this work. This unrelated pre-existing failure was not patched or hidden.

### Integrated fixes and compatibility evidence

The initial live contract run passed 35 tests and exposed one existing Inbox admission failure: PostgreSQL returns the compute revision bigint as a string, but the admitted run contract requires a number. `postgres.ts` now converts that revision at the admission boundary. The rerun passed all 36 tests. The expanded Inbox fixture proves a previously admitted profile remains unchanged after publishing revision 2, while the next capture receives the new model/revision.

Six additional live provider cases cover all four API-key providers, encrypted credential/account isolation, reconnect reference preservation, concurrent enrollment, rollback after failed mutation, atomic profile revision conflicts, and rejection of unsupported persisted providers. Synthetic keys and deterministic validation are used; no external provider was contacted.

Release fixtures combine the existing migration and capability contracts: Anthropic, OpenRouter, and OpenCode Go independently block an illustrative legacy target; unsupported exact models and absent capability metadata block selection. Checks leave local/server references and individual tool permission identities unchanged. Explicit repair uses each environment's own credential reference. These tests do not install every historical release or transfer secrets. The operator backup/target-catalog/admitted-run preflight is documented in [provider connections](../../../docs/provider-connections.md).

### Capability and dependency review

| Capability delta | Automated implementation evidence | Remaining gate |
| --- | --- | --- |
| Model provider settings: connected accounts, explicit defaults, environment credentials, migration | Provider UI/store, native credentials, Pi catalog/authentication, server API and live PostgreSQL suites; release fixtures | Real native provider flows and operator entitlement checks |
| General preferences: appearance, preview/motion, version | Appearance, settings migration/persistence, General/navigation and application-metadata fixtures | Native restart, contrast, typography/motion inspection |
| Settings navigation: hierarchy, honest async actions, server recovery, diagnostics | SettingsPanel, editor, compute/server settings and diagnostics fixtures | Native focus return and narrow layouts |
| Agent settings: dedicated editor, unified tools, individual MCP selection | AgentEditors, AgentSettings, ServerAgentSettings and permission-store fixtures | Native editing during admitted runs |
| Local agent extensions: generic details, retained configuration, explicit skill creation | ExtensionsSettings, extension host/API and generic executor suites | Native create/cancel/configuration flow |
| MCP settings: split inventories, URL-first setup, backend limits, compact review, neutral identity | McpSettings/store, MCP-host and permission publication fixtures | Native review/keyboard/long-text/local-server checks |

The integration boundaries in [foundation.md](foundation.md) remain in force: MCP uses existing discovery and fingerprinted grants; System One remains a generic extension/executor; local/server Pi share runtime/catalog/authentication rather than adding another runner; server executor admission remains authoritative with no device fallback. No dependent change's outstanding product or smoke task is marked complete by this review. Portable agent definitions, extension trust, document authority, and individual MCP permissions are not replaced by settings redesign.

### Explicitly pending

The user prohibits Computer Use permission requests and alternate GUI automation; root `AGENTS.md` now records that rule. An attempted native-app access was denied before any visual observations, and no further Computer Use is permitted. Task 6.3 remains the manual checklist in [desktop settings](../../../docs/settings.md). Browser-only verification would not substitute for native persistence and was not used.

Pencil screens were inspected earlier through the purpose-built connector. Final connector access failed with a disconnected IPC connection; no filesystem or GUI workaround was used and the design file was not edited by group 6. Two copy corrections remain: `UVrNy` must describe inherited compute without agent overrides; `SOQOK` must describe additive selected-tool grants, not exclusive agent access. Task 6.5 stays open for that reconciliation; task 6.6 stays open for final requirement evidence and completion review. Documentation updates do not claim these native gates passed, and no archive was performed.

The isolated native QA process was stopped. The Forage PostgreSQL container started for these checks was stopped afterward without deleting its volume or databases; unrelated containers were left alone.


## Foundation: tasks 1.1–1.4 (2026-09-29)

Scope, dependency checklist, pinned provider matrix, migration behavior, and intentional task-2/3 deferrals are recorded in [foundation.md](foundation.md). The open Pencil document was inspected, not edited. No browser, live model generation, paid connection validation, or PostgreSQL contract database was used.

### Passing checks

- Focused root tests for provider contracts, protocol compatibility, legacy compute/configuration fixtures, local credential migration, settings migration, MCP references, and server API/Pi adapter behavior passed. The initial focused run covered 130 tests; subsequent current-workspace coverage includes the additional provider protocol cases and unsupported local-provider guards.
- `pnpm --filter @forage/pi-runtime test`: 9 files, 54 tests passed, including exact resolution of all 423 catalog models, API-key auth mapping, existing ChatGPT OAuth, and shared run/conversation regressions. OpenRouter aliases required extending the bounded model-ID vocabulary to include `~`.
- The extension prerequisite stage of `TEST_DATABASE_URL= pnpm test` passed all eight package suites: extension API (5), reference extension (14), extension host (49), MCP host (12), image generation (13), System One (66), Pi runtime (54), and sidecar (31). All provider interactions in these checks use deterministic fixtures.
- Pi runtime, server, and sidecar typechecks, sidecar build, and desktop TypeScript/Vite build passed. Builds emit dependency annotation, dynamic-import, and chunk-size warnings; no new lint configuration was added.
- `openspec validate redesign-settings --strict` passed.
- `git diff --check` passed.

### Broader-suite limitations

The repository-wide `TEST_DATABASE_URL= pnpm test` also discovers the nested `.claude/worktrees/debug-relevant-placement` checkout. That untouched checkout contributes missing build artifacts, Node-test files collected as Vitest suites, and editor timer errors. The ordinary Vitest positional filters match substrings, so passing `apps packages` alone does not exclude that checkout.

The definitive current-source run was:

```bash
TEST_DATABASE_URL= pnpm exec vitest run \
  apps/desktop/src apps/server/src packages/agent-runtime/src \
  packages/protocol/src packages/domain/src packages/document/src \
  --exclude '**/.claude/**' --reporter=dot
```

Result: 130 files passed, 1 file failed, 1 skipped; 936 tests passed, 1 failed, 30 skipped. The remaining failure is `App view switching > keeps fresh edits behind an in-flight persistence retry` in `apps/desktop/src/App.test.tsx`, which does not observe the expected disk-error UI. The same failure was observed in the untouched nested checkout. No persistence/editor behavior was changed to repair this unrelated test.

Two integration fixtures were updated for the foundation's contracts: App's empty store now returns `undefined` for missing keys rather than an invalid empty-string versioned record, and the ChatGPT server-runner fixture uses catalog-supported `gpt-5.5` instead of silently falling back from unavailable `gpt-5`. Server-runner tests pass with exact model identity assertions in the current-source run.

Sandboxed pnpm invocations intermittently failed registry-signature verification due to unavailable network access; the corresponding validation commands were rerun with approval and succeeded in starting. No signature verification was bypassed and no dependencies or lockfiles were changed.

Full Tauri migration/restart testing, live provider connectivity, and PostgreSQL credential/profile integration checks remain for later implementation tasks. Task 1 completion is not a claim that the redesigned UI or new provider execution paths have shipped.

## Functional provider connections: tasks 2.1–2.5 (2026-09-29)

Implemented native/API-key references and sidecar payloads for all four API-key providers, retained ChatGPT OAuth, isolated Pi authentication from non-admitted ambient keys, and required exact admitted provider/model resolution. Server enrollment uses authenticated non-generation validation, encrypted storage, scoped sanitized account inventory, stable account references, capability gating by engine, revision-checked compute publication, and manual/retry/automatic admission snapshots. The Pi dispatcher now uses the selected provider rather than sending other providers' keys to an OpenAI endpoint.

Connection UI includes connected-account rows, a plus-icon Add provider action, the shared standard dropdown and provider-specific form, Manage/reconnect/disconnect, explicit atomic default selection, repairable disconnected defaults, and safe older-server restrictions. Persisted workspace mode controls inventory; failed server loads never expose local accounts. Cancelling setup clears submitted secrets and aborts local validation or native/server requests. Store tests cover concurrent connections and secret/metadata rollback after persistence failure.

### Implementation evidence

| Task | Deterministic coverage |
| --- | --- |
| 2.1 | `localCredentials.test.ts`, `piSdkClient.test.ts`, existing `codexAuth.test.ts`, native reference/credential tests, server credential refresh/revocation tests |
| 2.2 | Pi `runtime-auth.test.ts` and `provider-catalog.test.ts`: all five identities, all 423 exact catalog models, ambient-key isolation, unsupported provider/model rejection; server Pi/dispatcher tests |
| 2.3 | `app.test.ts`: all four API-key providers, capabilities, scoped non-secret inventory, unavailable models/credentials, revision conflicts, unchanged old snapshots and newly selected retry snapshots; Postgres enrollment query/transaction fixtures; existing repository/automation regressions |
| 2.4 | `provider-validation.test.ts`: fixed GET endpoints/headers, valid responses, 401/403/429/503, malformed/oversized bodies, sanitized network errors, timeout even with an uncooperative fetch, pre-cancel and in-flight cancel; native cancellation registration/cleanup tests and desktop transport cancellation |
| 2.5 | `ProviderConnectionsSettings.test.tsx`, `SettingsPanel.test.tsx`, and store provider tests: cancellation, failed validation, default disconnect/repair, explicit default save, server revision conflict, older-server limits, server failure isolation, return to local mode |

### Passing checks

- Final current-source root regression suite: **134 files passed, 1 skipped; 974 tests passed, 30 skipped**. Command: `TEST_DATABASE_URL= ./node_modules/.bin/vitest run apps/desktop/src apps/server/src packages/agent-runtime/src packages/protocol/src packages/domain/src packages/document/src --exclude '**/.claude/**' --exclude '**/src-tauri/**' --reporter=dot`. Localhost stream tests required the approved unrestricted rerun after sandboxed `listen EPERM`; the final run includes them. The previously observed App retry failure did not recur in this run.
- Pi runtime suite: **9 files, 58 tests passed**. Command from `packages/pi-runtime`: `./node_modules/.bin/vitest run --config vitest.config.ts --reporter=dot`.
- Packaged sidecar suite: **9 files, 31 tests passed**. Command from `apps/desktop/src-tauri/resources/pi/sidecar`: `./node_modules/.bin/vitest run --reporter=dot`. The packaged readiness fixture now supplies its explicit model instead of depending on an implicit fallback.
- Final targeted dispatcher sanitization run: **4 tests passed**. Provider UI/store focused runs and retained ChatGPT login/refresh tests also passed.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: **46 tests passed**, including provider-key isolation, local storage/revocation, cancellation-before-registration, origin pinning, and persistence/asset/session regressions.
- `pnpm build`: **11 workspace tasks successful**; desktop, server, shared package, and sidecar typechecks/builds pass. Existing dependency-annotation, dynamic-import/chunk-size, and Turbo output warnings remain nonfatal. The last dispatcher error-sanitization edit also passed the server typecheck.
- `openspec validate redesign-settings --strict --no-interactive` and `git diff --check` passed.

### Verification boundaries

No browser or persistent project runtime was launched. The open Pencil Connection/Add provider screens were read through Pencil without editing the design. Existing unrelated worktree/design changes were retained. Provider checks and model behavior use deterministic fixtures; no real credentials, paid model calls, or live provider entitlement checks were used.

The root regression command explicitly disables PostgreSQL contract tests. PostgreSQL enrollment locking/replacement/rollback has deterministic query-fixture coverage, not a claim of live database validation. Real Tauri visual/restart testing and actual dedicated-contract-database provider/profile checks remain tasks 6.1–6.4. General/nested navigation and readiness relocation remain task group 3; no later task group is marked complete here. Operational provider behavior is documented in `docs/provider-connections.md` and linked from architecture/server documentation.

## Task group 3 — Settings hierarchy and General

Implemented General-first typed section/nested-page navigation, parent selection, Back/Cancel focus restoration, and missing-entity fallback for existing provider, agent/skill, extension, and MCP flows. Explicit-save form extraction and dirty-draft guards remain task 4.1; URL-first MCP setup remains task 5.2.

Device appearance applies immediately through semantic theme tokens and outline/preview-only typography variables. Local persistence serializes with account mutations, coalesces rapid preference changes, retains unsaved appearance on failure, and offers retry. Missing/malformed stored preferences use compatible defaults without resetting compute or permissions. The preview is static nested HTML, not an editor. Application metadata uses the native running build version or explicitly labeled package metadata in development.

Nested Diagnostics runs bounded independent workspace, Node.js, and Codex checks. Its report admits fixed status labels and strict runtime versions only. Native/provider errors, tokens, credentials, paths, and MCP configuration are excluded. Model setup is an account/catalog check rather than a live model request. Node availability controls the local Agent service result; failed desktop runtime checks do not downgrade server execution.

Connection owns provisioning, readiness, conflict handling, and collapsed connection/recovery details. Failure to read persisted workspace/connection state exposes a retry rather than assuming local compute. Agents retains Inbox rules and shows read-only inherited compute with Change in Connection. Pencil screens `uFKHO` and `o4cSYt` were reconciled through the Pencil API: Run behaviour controls were removed, the model dropdown/override was replaced by an inherited-compute summary/link, and version text was labeled as running-build metadata. Both updated screens were screenshot-inspected without overflow in those frames. Existing unrelated design changes were preserved.

### Deterministic evidence

- Task 3.1: `SettingsPanel.test.tsx` covers section order, General entry, no Advanced, nested parent selection, Diagnostics Back/focus, provider cancel/focus fallback, and deleted-agent fallback. Existing provider/extension/MCP component fixtures remain passing.
- Task 3.2: `appearance.test.tsx`, `settingsStoreMigration.test.ts`, and the panel preview test cover OS appearance/motion changes, explicit theme isolation, listener cleanup, typography variables, rapid writes, sanitized persistence failure/retry, reconstructed restart state, malformed preference defaults, static nesting, and unchanged agent/document behavior.
- Task 3.3: `applicationMetadata.test.ts` and `DiagnosticsSettings.test.tsx` cover native/development version sources, independent failure results, pending/timeout states, report copying, strictly admitted versions, and no local compute fallback when a server profile fails.
- Task 3.4: `ComputeSettings.test.tsx`, `ServerAgentSettings.test.tsx`, and existing configuration mirror, provisioning, server configuration publication, and server executor regressions cover placement, Inbox rules, copy/enrollment/credential progression, failures, conflict recovery, and unchanged authority.
- Task 3.5: inherited-compute panel tests plus Pencil API reads/screenshots confirm no per-agent model selector or unsupported result-placement switches.

### Passing commands and boundaries

- Focused desktop/settings/store suite: **14 files, 100 tests passed**. `./node_modules/.bin/vitest run apps/desktop/src/components/Settings apps/desktop/src/appearance.test.tsx apps/desktop/src/applicationMetadata.test.ts apps/desktop/src/store/settingsStoreMigration.test.ts --exclude '**/.claude/**' --reporter=dot`.
- Broad regression suite: **137 files passed, 1 skipped; 992 tests passed, 30 skipped**. `TEST_DATABASE_URL= ./node_modules/.bin/vitest run apps/desktop/src apps/server/src packages/agent-runtime/src packages/protocol/src packages/domain/src packages/document/src --exclude '**/.claude/**' --exclude '**/src-tauri/**' --reporter=dot`. The unrestricted rerun permits localhost stream sockets; the sandboxed attempt encountered `listen EPERM`. The broad run precedes the final focus-identity refinement, which is covered by the subsequent focused suite/typecheck. Existing React act warnings remain nonfatal; the previously intermittent App retry test passed on the unrestricted runs.
- `./node_modules/.bin/tsc -p apps/desktop/tsconfig.json --noEmit` passed.
- `pnpm build`: **11 workspace tasks successful**, including desktop CSS compilation. Pinned package-manager runtime access required the approved unrestricted execution; existing chunk-size/dependency-annotation/Turbo output warnings remain nonfatal.
- `openspec validate redesign-settings --strict --no-interactive` and `git diff --check` passed.

No browser, persistent runtime, live provider request, real Tauri restart/visual check, or PostgreSQL contract database was used. Restart/default verification uses deterministic settings-store reconstruction. Task group 6 retains actual Tauri/local-server integrated verification, contrast/narrow layouts, live contract-database checks, and downgrade preflight. Tasks 4–6 are not marked complete.

## Task group 4 — Agent and extension editing

Implemented reusable dedicated agent/skill editors with explicit Save/Cancel, guarded dirty-draft navigation, retained validation/persistence/publication errors, and retryable publication without duplicate local creation. Changes remain drafts until Save; previously admitted configurations remain unchanged. New agents start with no tool grants.

Ordinary agent tools share one source-labeled list, while missing or unavailable saved references remain inspectable and survive unrelated edits. Tool availability intersects global policy, extension readiness/trust, and the confirmed execution environment. Per-server MCP access stages individually reviewed tool IDs only; cancelling review grants nothing, disabling removes only that agent's current server references, and inventory/fingerprint changes invalidate new grants before Save. There is no wildcard or persisted master authorization.

Extension detail uses the same metadata-driven Configuration, Tools, Agent access, Use in a skill, and collapsed Extension details hierarchy for normal, empty, missing-manifest, untrusted, and incompatible sources. Create skill reuses the ordinary editor and declared executor schema; activation/cancellation never creates a skill. Required source configuration and readiness gate authorization and creation. Technical/trust/error information remains inspectable, and bounded host-sanitized diagnostics remain copyable through Copy diagnostics rather than Copy report. No extension-supplied UI is loaded.

### Deterministic evidence

- Task 4.1: `AgentEditors.test.tsx`, `AgentSettings.test.tsx`, `SettingsPanel.test.tsx`, and `App.test.tsx` cover failed saves retaining drafts, discard/keep editing, sidebar/Back/keyboard exits, unchanged saved/admitted snapshots, and publication retry without a second local save.
- Task 4.2: agent editor fixtures cover source labels, retained missing IDs, globally disabled tools, server-mode device-local extension isolation, and unchanged references after unrelated edits. Existing extension-host trust/readiness and runtime admission regressions remain passing.
- Task 4.3: agent/MCP fixtures cover first-enable explicit unchecked review, cancel, individual selection, agent-only disable, globally disabled tools, and changed inventory/fingerprints during and after review.
- Tasks 4.4 and 4.6: `ExtensionsSettings.test.tsx` covers System One/Text Stats, empty configuration/tools/executors, missing/incompatible manifests, trust review, required source configuration, sanitized diagnostics, and absence of Copy report. Existing lifecycle and native-vault configuration fixtures remain passing.
- Task 4.5: extension/skill fixtures cover no automatic creation, cancellation with focus return, invalid/duplicate labels, generic executor configuration, and successful explicit creation. Global extension policy edits do not mutate agent grants or source trust.

### Passing commands and boundaries

- Focused settings suite: **12 files, 103 tests passed**. `./node_modules/.bin/vitest run apps/desktop/src/components/Settings --exclude '**/.claude/**' --reporter=dot`.
- Final current-source regression suite: **138 files passed, 1 skipped; 1009 tests passed, 30 skipped**. `TEST_DATABASE_URL= ./node_modules/.bin/vitest run apps/desktop/src apps/server/src packages/agent-runtime/src packages/protocol/src packages/domain/src packages/document/src --exclude '**/.claude/**' --exclude '**/src-tauri/**' --reporter=dot`. Approved unrestricted execution permits the existing localhost stream tests. Nested historical worktrees are excluded explicitly.
- Extension-host suite: **7 files, 49 tests passed**. From `packages/extension-host`: `./node_modules/.bin/vitest run --config vitest.config.ts --reporter=dot`.
- `./node_modules/.bin/tsc -p apps/desktop/tsconfig.json --noEmit` passed.
- `pnpm build`: **11 workspace tasks successful**. Existing dependency-annotation, dynamic-import/chunk-size, and Turbo output warnings remain nonfatal. Pinned package-manager runtime access required approved unrestricted execution.
- `openspec validate redesign-settings --strict --no-interactive` and `git diff --check` passed.

The open Pencil extension designs were read through Pencil without editing them; existing unrelated design/worktree changes were preserved. No browser, persistent runtime, live provider call, real Tauri visual/restart check, or PostgreSQL contract database was used. Integrated native/local-server verification and accessibility/layout observations remain task group 6, not claims made by these component tests. MCP source setup/inventory redesign remains task group 5. Tasks 4.1–4.6 are complete; task groups 5 and 6 remain unchecked. Behavior and permission boundaries are documented in `docs/settings.md`.

## Task group 5 — MCP settings flows

Implemented Connected/Detected inventories with source/status/access information, definition-identity deduplication, empty/partial/failure states, and one Add server entry into dedicated URL-first setup. Command fields have their own draft; optional JSON import is collapsed. Only the chosen method is submitted, successful connection clears credential-bearing inputs, and dirty Cancel/Back/section changes are guarded. Existing discovery/import validation, configuration vaulting, and source-client ownership remain unchanged. Tool refresh now preserves an imported connection's discovery identity so an unchanged source is not offered again.

Manual and detected connections open individual tool/agent review without automatic grants. Successful JSON imports enter review one connection at a time; cancellation leaves all imports saved without new authorization. Partial import failure retains earlier saved connections without falsely reporting full success. Save access extends the existing atomic settings service with an optional reviewed-ID scope: global policy changes affect only current reviewed tools, explicit agent selections receive additions only, unrelated permissions and saved agent references remain intact, and global policy can be saved without assigning an agent. Failed local persistence retains unchanged active settings; failed publication is distinguished and unchanged retry republishes without repeating the local save.

Manage places Refresh tools beside Tools and renders bounded untrusted descriptions as one-line ellipsized previews with independent keyboard-accessible disclosures. Names/descriptions are plain text, control/bidi formatting is stripped from presentation, and every server uses the same neutral plug icon without fetching remote icon metadata. Inventory/fingerprint changes invalidate open review, including server reload while the review remains mounted; refreshing does not authorize new definitions. Connection lifecycle actions are collapsed and disabled during access saves.

Persisted server mode renders operator-owned metadata and excludes local discovery, setup, enable/disable, and disconnect mutations. Permission editing still uses the existing authorized configuration publication path. Backend/mode-load errors are sanitized and retryable, with no desktop inventory fallback or executable backend configuration export.

### Deterministic evidence

- Task 5.1: `McpSettings.test.tsx` covers mixed, empty, partial, and failed scans, same-name candidates with distinct definitions/source labels, neutral icons, and no duplicate unchanged import. `mcpStore.test.ts` covers exact candidate identity, explicit renaming of variants, preserved discovery identity after refresh, and no scan/import authorization. Existing MCP-host discovery fixtures cover cross-client deduplication and independent source failures.
- Task 5.2: setup fixtures cover dedicated URL-first navigation, collapsed JSON, independent method drafts and payloads in both directions, token/header conflicts, command quoting/environment/cwd, cleared secrets after success, sanitized errors with retained non-secret inputs, dirty exit handling, and focus return.
- Task 5.3: candidate/review/store fixtures cover credential prompts, changed-source rejection, unsupported configurations, explicit tool and agent selection, cancellation without grants, multi-import/partial-import handling, scoped atomic policy persistence, unchanged saved/admitted state after failure, and publication-only retry.
- Task 5.4: tool-review fixtures cover actual preview truncation classes, bounded full text, script-like descriptions rendered as text, Enter/Space disclosure activation without authorization changes, top-positioned Refresh, and changed inventory/fingerprints requiring renewed review with new tools unchecked.
- Task 5.5: server fixtures cover absence of device mutations/discovery, authorized server-tool selection, no desktop fallback on backend/mode-load failure, sanitized retry errors, and changed definitions after server refresh. Manage/Cancel and removed-connection fixtures cover focus return and safe missing-entity fallback.

### Passing commands and boundaries

- Final focused settings/store suite: **14 files, 133 tests passed**. `./node_modules/.bin/vitest run apps/desktop/src/components/Settings apps/desktop/src/store/mcpStore.test.ts apps/desktop/src/store/settingsMcpAccess.test.ts --exclude '**/.claude/**' --reporter=dot`.
- Final current-source regression suite: **138 files passed, 1 skipped; 1028 tests passed, 30 skipped**. `TEST_DATABASE_URL= ./node_modules/.bin/vitest run apps/desktop/src apps/server/src packages/agent-runtime/src packages/protocol/src packages/domain/src packages/document/src --exclude '**/.claude/**' --exclude '**/src-tauri/**' --reporter=dot`. Approved unrestricted execution permits the existing localhost socket fixtures; nested historical worktrees are excluded explicitly. An earlier run reproduced the previously documented intermittent App persistence-retry failure; subsequent runs passed without changing that unrelated test. Existing React act warnings remain nonfatal.
- MCP-host suite: **2 files, 12 tests passed**. From `packages/mcp-host`: `./node_modules/.bin/vitest run --config vitest.config.ts --reporter=dot`. The sandboxed HTTP fixture encountered `listen EPERM`; the approved unrestricted rerun passed.
- `./node_modules/.bin/tsc -p apps/desktop/tsconfig.json --noEmit` passed.
- `pnpm build`: **11 workspace tasks successful**. Existing dependency-annotation, dynamic-import/chunk-size, and Turbo output warnings remain nonfatal; pinned package-manager runtime access used approved unrestricted execution.
- `openspec validate redesign-settings --strict --no-interactive` and `git diff --check` passed.

Pencil screens `yD3fN`, `SOQOK`, `mYqK6`, and `i7FjPu` were read through Pencil without modifying the design. Existing unrelated design/onboarding/staged work was preserved. No browser, persistent project runtime, live provider request, real Tauri visual/restart check, or PostgreSQL contract database was used. MCP-host connection tests use deterministic subprocess/localhost fixtures, not real third-party server credentials. Documentation was updated in `docs/settings.md`, `docs/mcp.md`, and `docs/architecture.md`. Tasks 5.1–5.5 are complete; integrated native/local-server verification and release documentation reconciliation remain task group 6, which stays unchecked.
