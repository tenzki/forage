# Slice 7 verification

Verified on 2026-09-19 in the repository workspace. Tests use offline fixtures and a deterministic fake model; no paid model call or PostgreSQL service is required.

## Automated acceptance evidence

| Capability spec | Evidence |
| --- | --- |
| `extension-authoring` | `packages/extension-api/tests/index.test.ts` proves the host-independent public surface. `packages/extensions/tests/text-stats.test.ts` verifies manifest/runtime declarations, settings, hooks, input bounds, Unicode counting, progress, cancellation, and no network/model call. `reference-extension.integration.test.ts` inventories and validates the compiled reference entry, creates/verifies an admission snapshot, denies the unauthorized tool, invokes the authorized tool through the private sidecar adapter with a fake model, records extension provenance/progress/logs, and validates the structured JSON result and cancellation. Repository install has no configuration mutation path. |
| `local-agent-extensions` | Agent-runtime, inventory, configuration, runtime, snapshot, management, tool-policy, validation-process, local-credential, Settings, and Pi-client suites cover manifest-only discovery, ambient-source exclusion, explicit trust, exact manifest/runtime agreement, app-rendered settings and secret references, retained unavailable selections, collisions, common allowlisting, stale admission, local-only authority, bounded activity, log sanitization, and cancellation/termination. `management-process.integration.test.ts` boots the real JSONL management resource against a temporary `.forage` and exercises drop-in discovery, local preview/registration, enablement, configuration, edited-entry reload, removal, and preservation of the external directory. It also boots both self-contained production entries without runtime `node_modules`. |
| `extension-packages` | `packages/extension-host/tests/lifecycle.test.ts` covers npm/Git/local parsing, resolved revisions and pins, missing executables, script-disabled staging, lifecycle-script rejection, syntax/dependency failures, atomic registration/update, retained active revisions, managed/local removal boundaries, and offline inventory/invocation behavior. Management and Settings tests cover explicit preview/install/update/remove actions and separation from trust, configuration, and authorization. No real registry or remote is contacted by the test suite. |

The reference integration uses `packages/extensions/forage.extension.json` and its compiled `dist/index.js`; it does not duplicate the entry in a fixture. Source-mode management tests start `management.ts` with `node --import tsx` and let it start the credential-free validation worker. Production Tauri launches the self-contained `dist/index.mjs` and `dist/management.mjs` resources directly with Node; the packaged smoke test exercises those same entries without `tsx` or workspace `node_modules`.

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm --filter @forage/extensions build` | Passed. |
| `pnpm --filter @forage/extensions typecheck` | Passed. |
| `pnpm --filter @forage/extensions test` | Passed, 12 tests. |
| `pnpm test:extensions` | Passed: extension API 4, reference project 12, host 32, sidecar 20; 68 total. |
| Focused desktop extension/policy/client/settings command | Passed, 6 files and 27 tests. |
| `pnpm test:workspace` | Passed, 5 tests. |
| `pnpm build` | Passed, 6 Turbo tasks. Existing Vite annotation and large-chunk warnings remain non-fatal. |
| `pnpm --filter @forage/desktop tauri build --debug --no-bundle` | Passed; produced an arm64 Mach-O application with compiled sidecar resources. |
| `pnpm --filter @forage/desktop tauri build --debug --bundles app` | Passed; produced `Forage.app`. Both sidecar entries were executed from its `Contents/Resources` tree, and packaged management returned a valid inventory response. |
| OpenSpec `validate add-forage-extensions --strict` | Passed. |
| `git diff --check` | Passed. |
| `pnpm test` | Extension phase passed. Main Vitest phase: 664 passed, 24 skipped, 22 failed. The failures are pre-existing: 8 outline-stream tests cannot bind `127.0.0.1` in the sandbox; 13 outline-structure expectations fail; 1 outline-model collapsed-style assertion fails. No extension test failed. |

The focused desktop command was:

```bash
pnpm exec vitest run \
  apps/desktop/src/agent/extensionManagementClient.test.ts \
  apps/desktop/src/components/Settings/ExtensionsSettings.test.tsx \
  apps/desktop/src/components/Settings/SettingsPanel.test.tsx \
  apps/desktop/src/agent/definitions.test.ts \
  apps/desktop/src/agent/localCredentials.test.ts \
  apps/desktop/src/agent/piSdkClient.test.ts
```

## Native packaging check

The first native build exposed that Tauri did not copy pnpm's symlinked sidecar dependencies. The sidecar now builds self-contained ESM entries and a validation worker under `resources/pi/sidecar/dist`; desktop clients and the shell capability reference only `dist/index.mjs` and `dist/management.mjs`. Tauri's dev/build hooks generate those artifacts before launching or packaging.

The debug Mach-O executable and macOS `Forage.app` bundle both built successfully. The bundle contains the run, management, validation, and code-split resources without a runtime `tsx` or workspace `node_modules` dependency. The packaged run entry emitted `ready`; the packaged management entry emitted `ready` and returned a validated empty inventory against an isolated temporary `.forage`. Automated Settings tests cover unavailable selections and lifecycle actions, while the reference/fake-model and lifecycle suites cover activity provenance, cancellation, and managed install/update/removal. No paid model or public package registry was used.
