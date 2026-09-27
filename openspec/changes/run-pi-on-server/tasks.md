## 1. Shared Pi runtime package

- [x] 1.1 Create `packages/pi-runtime` with pinned `@earendil-works/pi-coding-agent` / `pi-ai` dependencies. Move `runtime-auth.ts`, `final-response.ts` and `emit_outline` into it from the sidecar. Verify `pnpm build` and the moved tests pass from the new package.
- [x] 1.2 Implement the `RuntimeTool` → Pi custom-tool adapter with authorization, bounded output and untrusted-source registration. Verify with unit tests for unauthorized calls, bounded output and verified-URL capture.
- [x] 1.3 Implement shared prompt composition (Decision 2) and source filtering of results. Verify with snapshot tests of the composed prompt with and without source material, and a filtering test.
- [x] 1.4 Implement tool-round and per-response call limits with the existing error codes (Decision 3). Verify with tests that drive a fake model past each limit.
- [x] 1.5 Implement `runPiTurn` with outcome tracking (first turn: outline or environment-specific fallback; resumed turn: outline or answer) and activity mapping to `activityEventSchema`. Verify with tests using a scripted Pi model runtime.
- [x] 1.6 Define the conversation-store interface (open new / resume by call identity, collect appended entries). Verify the local file store (from `add-agent-call-conversations`) implements it, with a resume test.

## 2. Desktop sidecar on the shared package

- [x] 2.1 Replace inline session construction in `sidecar/index.ts` with `runPiTurn`, keeping JSONL framing, local extensions and Codex subscription images as adapters. Verify the sidecar tests and the executor/extension integration tests pass.
- [x] 2.2 Verify local runs now apply the untrusted-material and verified-citation rules, with a local runner test where an unread URL is dropped from sources.

## 3. Server executor on Pi

- [x] 3.1 Add the `agent.engine` config (`pi` | `legacy`, default `pi`) and a startup check for Node ≥ 22.19. Verify with config tests and a startup test on an old-version stub.
- [x] 3.2 Switch `ServerAgentRunner` to `runPiTurn` with the server model runtime built from `ResolvedModelCredential`, keeping lease renewal, cancellation and `classifyRunFailure`. Verify `serverRunner.test.ts` passes unchanged for both credential kinds.
- [x] 3.3 Adapt `createServerToolRegistry` tools and `generate_image` asset references to the shared adapters. Verify `serverTools.test.ts` and an image-result placement test.
- [x] 3.4 Run Inbox automation through `runPiTurn` with source material and no conversation store. Verify `automation.test.ts` and the structured-result-required failure for prose output.
- [x] 3.5 Port the `runAgent` behavior tests (limits, authorization, source filtering, cancellation) to run against the Pi executor. Verify they pass with `agent.engine = pi`.

## 4. Server conversations

- [x] 4.1 Add migration `0006_call_conversations.sql` (`agent_call_turns`, `agent_runs.call_id` / `call_turn` with index, `agent_run_outputs.output_kind`). Verify `migrate.test.ts` and the PostgreSQL contract tests.
- [x] 4.2 Implement the PostgreSQL conversation store with temp-file rehydration and appended-entry collection, including credential redaction of stored entries. Verify with contract tests for resume, redaction and cleanup of temp files.
- [x] 4.3 Store turn entries in the settle transaction for both answers and revisions; retries rehydrate from the last committed turn. Verify with a contract test that simulates lease loss mid-turn and asserts exactly one stored turn.
- [x] 4.4 Extend the manual intent in `packages/protocol` with `conversation: { callId, turn }`. Enforce `call_busy`, `(call_id, turn)` uniqueness, `conversation_too_large` and `conversation_unavailable` (legacy engine) at admission. Verify with API tests for each error.
- [x] 4.5 Add `agent.result_committed` v2 with `replaces`, applied atomically on the server, with desktop replay and undo support. Keep the v1 reader. Verify with server contract tests and desktop replay/undo tests.
- [x] 4.6 Return `callId`, `turn` and answer text in run views, and delete turns with cleared history and by age limit. Verify with API tests.

## 5. Desktop server-mode replies

- [x] 5.1 Route replies to server calls through `serverRunManager` with `conversation`, and render answers and replacing versions with the shared thread model. Verify with run-manager and `ActivitySidebar` tests.
- [x] 5.2 Hide the reply box for Inbox automation runs and map the new admission errors to user messages. Verify with component tests.

## 6. Retirement and docs

- [ ] 6.1 Accept ADR-0022, mark ADR-0013 superseded in part, and update `docs/architecture.md`, `docs/server-backend.md` and the Node requirement in `AGENTS.md`. Verify the links resolve.
- [ ] 6.2 After one release on `pi`, remove `runAgent`, `composeAgentPrompt`, `OpenAIResponsesModelAdapter`, the model adapter types and the `legacy` engine flag. Verify `pnpm build` and `pnpm test` pass.
- [ ] 6.3 Once `add-agent-call-conversations` is archived, narrow its "Legacy single-shot steering" requirement to extension skills and pre-conversation history. Verify with `openspec validate --strict`.

## 7. Verification

- [ ] 7.1 With disposable credentials: run the same skill in local and server mode and compare prompts and tool sets from activity; reply with a question and a revision on a server call from two devices; kill a worker mid-reply and confirm one stored turn; run Inbox automation; roll back to `legacy` and confirm replies are refused.
