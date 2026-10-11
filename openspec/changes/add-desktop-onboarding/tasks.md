## 1. Establish shared setup and distribution boundaries

- [ ] 1.1 Extract reusable local provider connection/model controls and actions from `redesign-settings`; verify existing Settings authentication, cancellation, account preservation, and default-selection tests still pass.
- [ ] 1.2 Extract reusable extension configuration, tool review, and normal skill-draft controls; verify Settings retains explicit trust, global grants, assistant selection, executor validation, and cancel-without-save behavior.
- [ ] 1.3 Define first-party extension descriptors and package their built manifests/entries as desktop resources; verify a clean packaged installation resolves sources without developer repository paths and reads choice metadata without importing code or contacting a registry.
- [ ] 1.4 Extract reusable MCP inventory and URL/command/JSON forms from `redesign-settings`, leaving tool/assistant review in Settings; verify connection validation, secret handling, and existing definition-bound authorization still use the MCP client/store.

## 2. Add onboarding lifecycle and state

- [ ] 2.1 Add a versioned device-local onboarding record and serialized save/load adapter; verify progress contains no note text, secrets, transcripts, or effective permission copies and handles interrupted/failed writes.
- [ ] 2.2 Capture pre-bootstrap outline/settings existence and implement eligibility after successful hydration; verify fresh local, empty-existing, upgraded, completed, failed-load, and server installations choose the correct entry behavior without resetting data.
- [ ] 2.3 Implement the five-step transitions, pause/skip/completion, and reference reconciliation including MCP connection identities; verify revoked credentials, missing notes, changed extension/tool definitions, and interrupted operations require repair or explicit retry rather than automatic side effects.
- [ ] 2.4 Add Start setup/Resume setup in General settings; verify explicit entry in local mode, no automatic return after pause/completion, and an explanatory server-mode limitation without an environment switch.

## 3. Build the minimal window and first note

- [ ] 3.1 Add the plain onboarding presentation with compact step labels, instructions, adaptive content width, bottom navigation, and inline error states; verify screens 09A–09K fit supported windows with keyboard-visible focus and no full workspace chrome or tutorial rail.
- [ ] 3.2 Reuse the application-owned editor/session for onboarding note, command, and result screens; verify navigation does not create another document/editor authority, duplicate event capture, or lose selection/content.
- [ ] 3.3 Capture the first user's nonempty note and stable identity, gate Continue on acknowledged persistence, and show only instructional placeholders before input; verify nesting, durable undo, failed-save recovery, restart, and final workspace visibility.

## 4. Connect AI and run the first command

- [ ] 4.1 Bind provider setup to supported local descriptors/catalog and existing credential services; verify pending/expired/canceled/failed states, sanitized errors, secret cleanup, and retention of already committed connections.
- [ ] 4.2 Add verified-connection/model-selection states and explicit default confirmation; verify account connection alone does not change compute and unsupported selections cannot proceed to a run.
- [ ] 4.3 Add AI skipping and the context-sharing explanation; verify offline users retain their note and can reach extensions/MCP or the workspace without an account, a fabricated result, or hidden inference.
- [ ] 4.4 Connect an editable `/brainstorm` invocation and compact context indication to ordinary skill admission; verify Enter/Run performs one request, applies the established context budget/policy, and does not run on step entry or resume.
- [ ] 4.5 Bind pending/result/error states to persisted invocation/run references and normal cancellation/recovery; verify revisits do not rerun or duplicate output and retries are explicit.
- [ ] 4.6 Render actual committed output in the existing editor; verify direct edits, undo, Back, skip, and Open Forage preserve the note and result without requiring Activity or another agent turn.

## 5. Select and configure optional extensions

- [ ] 5.1 Render compatible installed/application-supplied choices, descriptions, prerequisites, and unchecked initial selections; verify selection alone performs no install, import, trust, activation, or tool grant.
- [ ] 5.2 Put Skip for now in bottom navigation beside Configure selected with Back on the left; verify skipping proceeds to optional MCP setup, leaves pending choices uninstalled, and preserves all already saved content/configuration.
- [ ] 5.3 Route selected absent sources through preview, inspectable source/revision review, and explicit install confirmation; verify cancellation performs no registration and failures preserve existing working sources.
- [ ] 5.4 Reuse manifest-rendered configuration and explicit trust, global-tool, and assistant selection controls; verify new choices are unchecked, credentials use existing secret boundaries, and enabling a source alone grants no tool access.
- [ ] 5.5 Add optional ordinary skill creation using validated unique labels and generic agent/executor settings; verify cancel/retry/resume creates no duplicates and missing prerequisites remain visible.
- [ ] 5.6 Support sequential multi-extension setup, per-source skipping, and partial success; verify configuration survives a later failure and completion distinguishes saved, enabled, skipped, and unresolved states.

## 6. Configure optional MCP connections

- [ ] 6.1 Add the MCP step after extension completion/skip using saved connected inventory and explicit client scanning; verify entry/resume performs no scans, launches, endpoint connections, imports, grants, or tool calls and discovery needs no model credential.
- [ ] 6.2 Add sanitized detected candidates with source labels and explicit Connect; verify empty/partial scans, stale-source rejection, missing credentials, unchanged-import deduplication, and preservation of the source client's files.
- [ ] 6.3 Reuse URL-first manual setup, optional token/headers, launch command/arguments/environment/cwd, and JSON import; verify method-specific submission, local execution guidance, bounded failures, native secret storage, and secret cleanup.
- [ ] 6.4 Return successful connections to the inventory and direct detailed tool/assistant configuration to Settings → MCP servers; verify onboarding introduces no grants, existing permissions retain their definition checks, and no detailed permissions step is required.
- [ ] 6.5 Add Back and MCP Skip for now in bottom navigation; verify saved connections persist, unsaved drafts are discarded, skips reach completion, and partial setup remains honest in the summary.
- [ ] 6.6 Persist only non-secret MCP references in progress and reconcile them on resume; verify no commands/environment/headers/tokens enter onboarding storage and unfinished connection work requires fresh action without invoking tools as a test.

## 7. Finish and verify the integrated flow

- [ ] 7.1 Add the actual-state completion summary including MCP connection/access and Open Forage; verify connected-but-ungranted servers are distinguished, terminal progress is acknowledged, failed marker saves remain retryable, and completed setup does not reopen.
- [ ] 7.2 Run focused lifecycle/document/provider/extension/MCP/run integration suites and desktop build; record exact commands/results in this change's verification document and resolve failures attributable to onboarding.
- [ ] 7.3 Exercise a real Tauri first launch through note editing, provider authorization, one AI command, extension setup, explicit MCP connection, and completion; verify no implicit grants, the later Settings route, Pen layout, keyboard-only use, and persisted note/result visibility.
- [ ] 7.4 Exercise native skip/offline, pause/restart, upgrade, failed authentication/run/package, multi-extension partial success, empty/partial MCP discovery, failed connections, and changed-definition invalidation; record observed spec outcomes without automatically repeating external actions.
- [ ] 7.5 Update user-facing setup documentation and reconcile illustrative Pen skip/trust/grant states with shipped controls; run `openspec validate add-desktop-onboarding --strict --no-interactive` and retain evidence for completed tasks.
