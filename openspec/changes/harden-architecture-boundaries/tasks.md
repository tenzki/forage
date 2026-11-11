Every task leaves `pnpm build` and `pnpm test` passing. Phases can ship separately.

## 1. Guard rails

- [ ] 1.1 Add a desktop import-direction test (declared layer order, directory cycles, `@tauri-apps` allowlist) seeded with the current violations as an explicit to-fix list. Verify it fails when a new violation is added.
- [ ] 1.2 Move activity types from `components/Agent/ActivitySidebar.tsx` to `agent/activity.ts`; move `normalizedUrl`, `fetchWithTimeout` and `validatePublicWebUrl` to `lib/`; move `OutlinePane` and `PaneActions` under `components/`. Verify the to-fix list from 1.1 shrinks to the native-access entries.
- [ ] 1.3 Delete code with only test callers: `agent/client.ts` loop, `agent/tools.ts` executors, `runSkillIntoEditor` and its helpers, `agent/serverCredentialMigration.ts`, `editor/agentEventBatch.ts`, the unused exports and legacy settings actions listed in the review. Verify with a grep for each removed symbol and a smaller webview bundle.
- [ ] 1.4 Update the `AGENTS.md` agent flow and `docs/architecture.md` to describe `skillExecution.ts`. Verify every named function has a production caller.
- [ ] 1.5 Give `document`, `domain`, `protocol` and the contracts package a `tsconfig.json` with explicit `lib`/`types` and a `typecheck` script; replace relative cross-package imports with package names; drop `../../packages` from the application `include`s. Verify a Node built-in import in an isomorphic package fails its typecheck.
- [ ] 1.6 Replace the root vitest exclude list and the `test:extensions` filter list with vitest `projects`. Verify the total test count is unchanged and each file runs once.
- [ ] 1.7 Declare `zod` in the sidecar package. Verify the sidecar builds from an isolated install.
- [ ] 1.8 Add `errorMessage`, `isAbortError` and `reportBackgroundError` helpers and route the silent startup catches in `App.tsx` through the sink. Verify with a test that a failed run recovery is recorded.

## 2. Error codes

- [ ] 2.1 Add the shared error-code union to `packages/protocol`. Verify with a type test that server and desktop import the same union.
- [ ] 2.2 Server: introduce `DomainError` with `{ code, httpStatus, retryable, recoveryAction }`, add `lease_lost`, `run_cancelled` and `rebase_required`, map PostgreSQL `40P01`, `40001` and `23505`, and move mapping into `setErrorHandler`. Verify `app.test.ts` status expectations and a new table-driven mapping test.
- [ ] 2.3 Server: update `classifyRunFailure` to use the new codes. Verify a lease-lost commit is not retried as a dependency failure.
- [ ] 2.4 Rust: add `CommandError { code, message, server_code }` with `From` for the typed errors and convert every command. Verify with unit tests per mapping and no remaining `Result<_, String>` in command signatures.
- [ ] 2.5 Desktop: add `nativeError()` and replace message matching in `settingsStore.ts`, `syncEngine.ts` and `ComputeSettings.tsx`. Verify no `.includes(` or regex test on an error value remains.

## 3. Sidecar contract

- [ ] 3.1 Add `packages/protocol/src/sidecar.ts` with schemas for commands, the run payload and events. Verify round-trip tests.
- [ ] 3.2 Use the schemas in `encodePayload`, `decodePayload`, `handleCommand` and the desktop event reader; reject invalid input. Verify a malformed run identifier fails the run and an unknown event is dropped and reported.
- [ ] 3.3 Move `structuredResultFromOutline` into `pi-runtime` and have the sidecar emit a schema-validated result in `agent_settled`. Verify server and sidecar produce equal results for the same outline.
- [ ] 3.4 Parse persisted turn outcomes with a schema in `run-turn.ts`. Verify a corrupted stored outcome fails recovery with a clear error.
- [ ] 3.5 Implement `SidecarProcess` and port the five clients to it. Verify each client's existing tests pass and an oversized line fails identically for all.

## 4. Migration ledgers

- [ ] 4.1 Server: add `schema_migrations`, the advisory lock, per-file transactions, checksum verification and the one-time bootstrap for existing databases. Verify with tests for second start, concurrent start, changed checksum and each historical schema state.
- [ ] 4.2 Make `postgres.test.ts` load migrations through `loadMigrations`. Verify no filename list remains in tests.
- [ ] 4.3 SQLite: track `PRAGMA user_version`, derive it once for existing databases, and refuse a newer schema. Verify with `event_store_tests.rs` cases for fresh, pre-tracking and too-new databases.

## 5. Server rules and ports

- [ ] 5.1 Decide the attempt limit for MCP-tool runs on the durable runtime and record it in the design. Verify by updating the one contract test that asserts it.
- [ ] 5.2 Extract `planCapture`, `planAutomationAdmissions`, `planEventAcceptance`, `buildResultCommittedEvent` and `planPlacement` into `apps/server/src/domain/` with unit tests. Verify both repositories call them and contain no copy of the extracted helpers.
- [ ] 5.3 Build the repository contract suite with `describe.each` over in-memory and PostgreSQL. Verify it reproduces each drift listed in the design before the fix and passes after.
- [ ] 5.4 Move the push staleness check inside `acceptEvents`, check duplicates before revision, and return a discriminated result. Verify concurrent pushes and a retried accepted batch through the contract suite and an HTTP test.
- [ ] 5.5 Split `ServerRepository` into the five ports, scope every run read by outline, and add transaction-accepting `AgentStore` primitives. Verify no raw SQL against agent tables remains in the outline repository.
- [ ] 5.6 Split `app.ts` into route plugins with an auth `preHandler` driven by route config, and extract `AgentAdmissionService` and `ComputeReadiness`. Verify a test that enumerates routes and fails on one without declared auth.
- [ ] 5.7 Publish agent configuration and compute profile in one transaction. Verify a forced failure leaves neither published.
- [ ] 5.8 Fix the smaller items: prune checkpoints written by reads, lock `retry`, add a tie-breaker to the run list cursor, give the in-memory `retry` its owner. Verify with contract tests for each.

## 6. Capture classification

- [ ] 6.1 Add `capture_classifications` and insert a job in the capture transaction when a dispatcher policy matches. Verify the capture transaction makes no outbound call.
- [ ] 6.2 Claim and run classification jobs in the worker with leases and a bounded retry count; admit runs idempotently. Verify restart-after-capture and repeated-classification tests.
- [ ] 6.3 Remove the awaited post-commit dispatcher call and add deadlines to every OAuth and model fetch. Verify a hanging token endpoint fails at its deadline.
- [ ] 6.4 Update `docs/server-backend.md`. Verify the text matches the capture tests.

## 7. Native layer

- [ ] 7.1 Split `persistence.rs` into the module directory without changing the public API; make the placement coupling in `append_event` an explicit call. Verify the 22 event-store tests pass unchanged.
- [ ] 7.2 Add `AgentRunStatus` and generate the SQL status lists from it. Verify with a test that every status is classified.
- [ ] 7.3 Extract `ServerClient` and reduce `sync_commands.rs` to adapters. Verify with stub-server tests for enrollment, upload, download hash mismatch, size cap and 401/426 mapping.
- [ ] 7.4 Add `install_server_connection` and `remove_server_connection` as single transactions; roll back enrollment on failure. Verify no orphan credential after a failed enrollment and after reconnect.
- [ ] 7.5 Make storage commands asynchronous on the blocking pool, return asset bytes as binary, verify the hash once, and paginate `events_after_sequence`. Verify with a concurrent-append ordering test and a frontend asset test using `ArrayBuffer`.
- [ ] 7.6 Close the webview unconditionally in `page_peek_close`; regroup page and shortcut modules under `page/`. Verify with a registry test that forces a clip-removal error.
- [ ] 7.7 Move the statics into managed state and use one lock helper that recovers from poisoning. Verify no `unwrap` or `expect` on a lock remains outside tests.
- [ ] 7.8 Add `bootstrap::native_state` and shared example helpers; make the examples use them. Verify the examples build and manage `McpOAuthState`.
- [ ] 7.9 Add `"webviews": ["main"]` to the default capability and spawn the sidecar from a resolved resource path. Record the manual check that a page webview cannot invoke an application command.

## 8. Frontend extraction

- [ ] 8.1 Add `editor/transactionMeta.ts` with typed accessors and replace string meta keys. Verify a grep finds no literal `forage*` meta key outside that file.
- [ ] 8.2 Extract `HistoryRecorder` and `applyRemoteProjection`. Verify by moving the undo-grouping and projection tests out of `App.test.tsx` into unit tests that render nothing.
- [ ] 8.3 Give `OutlineSession` one sync queue, `onProjection` and the scheduler; delete the lock and polling wait in `App.tsx`. Verify a sync requested during a sync applies its projection.
- [ ] 8.4 Add `SkillRunController` keyed by skill identifier and remove the window event. Verify a run requested with no slash menu mounted starts.
- [ ] 8.5 Split `executeInvocation` into extension, server and local strategies with injected dependencies and one activity emitter; derive the activity sequence from the store. Verify each strategy's unit tests and a run with more than 200 activity events.
- [ ] 8.6 Add the `native/` adapters and a shared `useStorageMode`; remove direct `invoke` calls from components and stores. Verify the allowlist in 1.1 has no component or store entries.
- [ ] 8.7 Extract `ServerProvisioningController` from `ComputeSettings.tsx`. Verify its state transitions in unit tests, including unmount during a request.
- [ ] 8.8 Create `createSettingsStore(deps)` with a `SettingsRepository` and split account actions from agent actions. Verify the five settings test files run without `vi.mock` of Tauri modules.
- [ ] 8.9 Keep trash and shortcut projections in `OutlineSession` and alias the UI types to the domain types. Verify the six `as unknown as` casts are gone.
- [ ] 8.10 Replace the remaining window events with typed calls or a typed bus, and add an application command table shared by the handler and the shortcuts panel. Verify the panel lists exactly the handled shortcuts.
- [ ] 8.11 Build slash-command highlighting from the configured skills. Verify a user-created skill is decorated.

## 9. Structural edits

- [ ] 9.1 Add tests that assert recorded step size and rebase behavior for each structural operation, plus a property test comparing transform results with the current whole-document results. Verify they fail on the current implementation for size and pass for equality.
- [ ] 9.2 Convert indent and outdent to targeted transforms. Verify 9.1 and the existing structure tests.
- [ ] 9.3 Convert move and duplicate. Verify 9.1, identity preservation and link resolution.
- [ ] 9.4 Convert trash and restore. Verify 9.1 and undo/redo round trips.
- [ ] 9.5 Hash the document once per captured transaction and chain hashes between events. Verify with a counter in the capture tests.
- [ ] 9.6 Record the pending manual check: structural edits in the native app on a large outline, in local and server mode, with undo and a concurrent remote edit.

## 10. Packages and extensions

- [ ] 10.1 Remove the `legacy` engine, `serverModel.ts`, `runAgent`, `composeAgentPrompt` and the model adapter types; fail startup on `FORAGE_AGENT_ENGINE=legacy`. Verify the server tests for both paths are reduced to one.
- [ ] 10.2 Split `contracts.ts` and `extensions.ts` along their sections, move extension schemas next to `extension-api`, and rename the package to `agent-contracts`. Verify no behavior test changes.
- [ ] 10.3 Decompose `runPiTurn` and `extension-host/runtime.ts`; share one redactor and one set of path helpers. Verify existing tests and a reentrancy test for console capture.
- [ ] 10.4 Add `tool`, `run:start` and `run:end` to the executor worker protocol and route extension tools and hooks through it. Verify a test extension cannot read the model credential or another installation's secrets.
- [ ] 10.5 Declare replay safety and MCP origin on `RuntimeTool` and remove the hard-coded lists from `pi-runtime`. Verify the replay tests.
- [ ] 10.6 Drop the unused schema (`asset_cache`, `provisioning_steps`, two `agent_runs` columns) in a migration. Verify contract tests and a grep for each name.

## 11. Styles and docs

- [ ] 11.1 Split `style.css` by feature next to its components and delete rules superseded by the later design layers. Record the pending manual visual check of every primary surface in light and dark themes.
- [ ] 11.2 Write ADRs for boundary error codes, the sidecar contract and capture classification; update `docs/architecture.md`, `docs/extensions.md` and `docs/tools-architecture.md`. Verify links resolve.
