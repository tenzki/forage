## 1. Contracts

- [x] 1.1 Add optional `thread: { callId, turn }` to the local `RunInput` / run snapshot schema in `packages/agent-runtime`; verify schema tests accept first-turn and reply snapshots and reject an invalid `callId` or a non-positive `turn`.
- [x] 1.2 Add the local answer outcome schema (`{ version: 1, type: 'answer', text }`, at most 20,000 characters) next to `structuredResultSchema`, without changing the server result union; verify with schema tests and `pnpm --filter @forage/server typecheck`.
- [x] 1.3 Make the run-history reader (`persistence/eventStore.ts`) accept `thread` snapshots and answer outcomes; verify that a history-round-trip test loads a mixed legacy/threaded/answered history.

## 2. Sidecar sessions

- [x] 2.1 Replace `SessionManager.inMemory()` with `create` (new) / `open` (resume) under `<agentDir>/agent-sessions/<callId>.jsonl`, deriving the path only from a validated `callId`; verify with a sidecar test that a second run in resume mode sees the first run's messages.
- [x] 2.2 Fail resume closed when the session file is missing or unreadable, with the "history is no longer available" error; verify with a sidecar test.
- [x] 2.3 Add the follow-up message format (fresh context, invocation subtree, `User follow-up:`) and the follow-up system-prompt addendum; verify with unit tests for the message builder.
- [x] 2.4 Report the turn outcome in `agent_settled` (outline emitted or text answer); verify with a `final-response` test for both outcomes.

## 3. Desktop run flow

- [x] 3.1 Carry `thread` through `piGeneration` / `piSdkClient` and `piLocalRunner`; on follow-up turns return an answer outcome instead of `textNodes`; verify with `piLocalRunner` tests for first-turn fallback, follow-up answer and follow-up outline.
- [x] 3.2 Let `LocalAgentExecutor` settle runs with either outcome; verify with executor tests.
- [x] 3.3 Build the invocation-subtree section (agent vs user bullets, within the context budget) next to `resolveAgentContext`; verify with context tests, including the over-budget failure.
- [x] 3.4 Change `steerCall` / `runSkill` for threaded calls: no up-front `takeAiOutput`; stream deltas to the thread; on an outline outcome, replace the previous agent output and insert the result in one transaction and record the replaced output; on an answer outcome, leave the outline untouched. Verify with tests that failure and cancellation leave the outline unchanged and that user bullets under the invocation survive a revision.
- [x] 3.5 Keep the legacy `steeredPrompt` path for calls without `thread` (server mode, extension skills, old history); verify the existing `skillRuns` tests still pass and add a test for path selection.

## 4. Activity thread

- [x] 4.1 Group calls by `thread.callId` with the heuristic fallback in `groupSkillCalls` / `callsFromHistory`; verify with tests that a repeated identical run from the outline starts a new call.
- [x] 4.2 Add `answer` thread items (streaming and persisted), and number versions by outline-producing turns only; verify with `skillCallThread` tests.
- [x] 4.3 Render answers and streaming text in `ActivitySidebar`, and update the composer hint from "Replaces vN with vN+1" to wording that covers both answers and revisions; verify with `ActivitySidebar.test.tsx` and the UI gallery.

## 5. Storage lifecycle and docs

- [x] 5.1 Delete session files of cleared calls in the native history-clear path (keeping retained unplaced results), and prune orphaned session files at startup; verify with `cargo test` under `apps/desktop/src-tauri/`.
- [x] 5.2 Accept ADR-0022 (Pi loop in both environments, per-call conversation stores), mark ADR-0013 superseded in part and update `docs/architecture.md`'s agent flow; verify the docs are linked from the ADR index.

## 6. Verification

- [x] 6.1 Run `pnpm test`, `pnpm build` and `cargo test`, then check manually in `pnpm dev:desktop`: run a research skill, ask a follow-up question (inline answer, outline unchanged), ask for a change (new version replaces the old one), cancel a reply (outline unchanged), restart the app (thread intact), clear activity (session files removed).
