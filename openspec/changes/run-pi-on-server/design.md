## Context

See proposal.md and [ADR-0022](../../../docs/ADRs/ADR-0022-pi-agent-loop-in-both-environments.md). Current state that shapes the approach:

- **Server loop.** `ServerAgentRunner` (`apps/server/src/serverRunner.ts`) holds a lease, resolves the credential (`ResolvedModelCredential`: `openai` API key or `openai-codex` access token and account), builds `RuntimeTool`s from `createServerToolRegistry`, calls `runAgent`, then `repository.commitAgentResult`. Failures are classified into retryable and terminal codes; runs retry with backoff up to `max_attempts`, and a lost lease abandons the attempt.
- **`runAgent` behavior** (`packages/agent-runtime/src/runtime.ts`) that users rely on:
  - at most 8 tool rounds (hard cap 20) and 16 calls per round;
  - unauthorized tool calls return a tool error;
  - bounded tool output;
  - `UntrustedSourceMaterial` results register verified source URLs, and result `sources` are filtered to them;
  - the system prompt adds the untrusted-material and verified-citation rules;
  - the final output must be a v1 structured result, which the Responses adapter forces through a JSON schema.
- **Desktop sidecar.** It builds Pi sessions inline in `index.ts`. Its system prompt is `instructions` plus an `emit_outline` rule, with no untrusted-source or citation rules. The final output comes through the `emit_outline` tool, with a text fallback. `runtime-auth.ts` already accepts the same two credential shapes the server resolves.
- **Pi requirements.** The Pi SDK requires Node ≥ 22.19. `SessionManager.open(path)` resumes from a JSONL file; there is no public API that loads arbitrary entries into an in-memory manager.
- **Server tables.** `agent_runs`, `agent_run_events`, `agent_run_outputs` (placement state) and `agent_run_results` (committed root note IDs) exist. `agent.result_committed` v1 inserts one generated subtree atomically.
- **Local conversations.** `add-agent-call-conversations` defines `thread: { callId, turn }`, the answer outcome, and a session-open function keyed by call identity.

## Goals / Non-Goals

**Goals:**

- One Pi-based session setup used by both environments, with no behavior forks beyond environment adapters.
- Server runs keep every existing guarantee: admission, idempotency, leases, retries, cancellation, activity and atomic placement.
- Server-mode calls support the `agent-call-conversations` behavior.

**Non-Goals:**

- Local extensions on the server (still never; ADR-0021).
- Conversations for Inbox automation runs. They execute on Pi, but store no transcript and cannot be replied to.
- Moving the Inbox dispatcher classifier onto Pi. It is a single bounded classification call, not an agent loop.
- Resuming a call in a different environment than the one that started it.
- Changing local-mode transcript storage (JSONL files, per `add-agent-call-conversations`).

## Decisions

### 1. Shared package `packages/pi-runtime`

A Node-only workspace package with no Tauri, React, Fastify or PostgreSQL dependency. It exports `runPiTurn(input, adapters, options)`:

- `input`: validated `RunInput` (including optional `thread`), the follow-up text for resumed turns, and `UntrustedSourceMaterial[]` for automation.
- `adapters`:
  - `modelRuntime`, built from the shared credential shapes (moved from the sidecar's `runtime-auth.ts`);
  - `tools`: `RuntimeTool[]` plus environment-specific Pi tools;
  - `images`: an image-reference resolver for `emit_outline`;
  - `conversation`: an optional conversation store;
  - `onActivity` and `onDelta`.
- Returns an outcome: `{ type: 'outline', outline } | { type: 'answer', text }`. `outline` is what `emit_outline` returned: materialized nodes (images carry the resolver's `src`) and the result's verified `sources`. Each environment turns it into its result: the desktop keeps its current node materialization, and the server builds a v1 `StructuredResult` with asset IDs from its resolver.
- `input` is normalized to a `PiTurnRequest` (`turnRequestFromRunInput` builds it from a validated `RunInput`), because the sidecar's JSONL payload is not a `RunInput`.
- Environment Pi tools are passed as a factory that receives the turn's verified-source registry, so a local source-reading tool such as `web_fetch` can register the URLs it read.

It owns:
- prompt composition;
- tool filtering to `effectiveToolIds` and required-tool checks;
- the `RuntimeTool` to Pi custom-tool adapter;
- `emit_outline`;
- final-response and outcome tracking;
- source verification and filtering;
- activity mapping to `activityEventSchema`;
- the limits in Decision 3;
- abort handling.

The sidecar keeps its JSONL process protocol, local extension loading and Codex subscription image generation as adapters.

Alternative considered: a copy of the session setup in the server. Rejected because drift is exactly what ADR-0022 removes.

### 2. One prompt composition

The system prompt is:
1. agent instructions;
2. skill instructions;
3. the untrusted-material rule;
4. the verified-citation rule;
5. "Return the final result by calling `emit_outline`";
6. on resumed turns, the follow-up addendum from `add-agent-call-conversations`.

The first user message is the outline context, then untrusted source material blocks when present, then `Task: <prompt>`. Local mode gains the untrusted-material and citation rules, plus source filtering. This is an intended behavior change covered by `agent-runtime-parity`.

### 3. Carry over `runAgent` limits

Pi does not cap tool rounds, so the package counts them through session events:
- a turn that starts tool round 9 (configurable up to 20) aborts with `tool_round_limit`;
- tool calls beyond 16 in one assistant message get a bounded tool error;
- tool outputs pass through the existing `boundedToolOutput`;
- unauthorized tool names get "Tool is not authorized for this run.".

Pi resolves tool names before any hook runs and answers an unknown name with "Tool <name> not found", so the package rewrites those results to the authorization message when converting context for the model. The per-response cap wraps the agent's `beforeToolCall`, and the round cap aborts the session on the `turn_start` that would begin round 9.

Error codes keep their current names, so `classifyRunFailure` and the client error mapping do not change.

### 4. Outcome instead of forced JSON

Both environments end a turn through `emit_outline`, validated as a v1 structured result. `emit_outline` gains an optional `sources` list, filtered to verified URLs when the tool runs. A first turn that ends with text only:
- in local mode, keeps the text-to-bullets fallback, as today;
- in server mode, fails with `structured_result_required`, as `runAgent` does today, so unattended automation never places free text.

Resumed turns may end with text, which becomes the answer outcome in both environments.

### 5. Server tools as Pi tools

`createServerToolRegistry` keeps producing `RuntimeTool`s with their existing URL inspection, size bounds and untrusted-source typing. The package adapts them to Pi tools. `generate_image` keeps `OpenAIImageAssetGenerator`. Its asset ID is registered with the image resolver, so `emit_outline` image nodes reference server assets directly. The sidecar's resolver keeps its current generated-image map and ingestion path.

### 6. Server conversation storage

New table `agent_call_turns`:
- `call_id`, `turn`, `run_id` (references `agent_runs`, `ON DELETE CASCADE`), `owner_id`, `outline_id`;
- `entries jsonb` (the Pi session entries appended by that turn), `entry_bytes`, `created_at`;
- primary key `(call_id, turn)`.

`agent_runs` gains nullable `call_id` and `call_turn`, indexed by `(outline_id, call_id)`.

Resume uses only public Pi API:
1. concatenate the call's committed entries in turn order;
2. write them to a per-attempt temporary session file under the worker's temp directory;
3. `SessionManager.open` it and run the turn;
4. collect the entries added after the loaded leaf;
5. delete the file in `finally`.

Alternative considered: loading entries straight into `SessionManager.inMemory()`. Rejected because it depends on non-public API.

### 7. Retry and lease safety

A turn's entries are written only in the transaction that settles the run (Decision 8). A retried attempt, or one taken over after a lost lease, rehydrates from the last committed turn and replays the whole turn, so partial entries are never stored. Admission rejects a reply with `call_busy` while any run of the call is not terminal. That enforces a single active turn per call across devices.

### 8. Settling answers and replacing revisions

- **Answer:** in one transaction, insert the `agent_call_turns` row, store the answer in `agent_run_outputs` with `output_kind = 'answer'` (never placed; the placement check is exempt), and mark the run `completed`. The outline is not touched.
- **Revision:** in one transaction, insert the turn row and commit `agent.result_committed` v2 with `replaces: { runId, rootNoteIds }`. The server removes those previous generated roots that still exist under the invocation and inserts the new subtree. It is one outline event, one synchronization unit and one undo unit. Desktop replay learns v2, and v1 events replay unchanged.
- **Missing target:** a revision whose invocation bullet is gone becomes `completed_unplaced` (ADR-0020), and its turn is still recorded.

### 9. Intent, API and desktop

- The manual intent gains an optional `conversation: { callId, turn }`. The first turn omits it; the server assigns `callId = runId` and `turn = 1`.
- A reply sends `conversation`, the reply text as `prompt`, and a new `invocationId`. The server resolves fresh context (plus the invocation subtree) at admission, as ADR-0019 already requires.
- Idempotency stays per `invocationId`, and `(call_id, turn)` uniqueness rejects a conflicting second reply.
- Run views include `callId`, `turn` and the answer text.
- The desktop routes replies to server calls through `serverRunManager` and renders them with the same thread model as local calls.
- Once `add-agent-call-conversations` is archived, narrow its "Legacy single-shot steering" requirement to extension-backed skills and pre-conversation history.

### 10. Lifecycle and limits

- Clearing finished server history deletes the calls' runs, and turns cascade.
- Retained unplaced results keep their call.
- A per-call transcript budget (default 2 MB of entries) and a per-owner age limit (default 90 days, configurable) are enforced. Admission refuses a reply to a call over budget with `conversation_too_large`, telling the user to start a new call. Pi compaction usually keeps calls well under that budget.
- Known credential values and `Bearer`/`sk-` patterns are redacted from tool-result entries before storage, using the same patterns as `safeFailureDetail`.

## Risks / Trade-offs

- [The server takes a runtime dependency on Pi, including transitive packages it does not use] → Pin versions, import only SDK entry points, check the server bundle size and startup, and run the existing server test suite against the Pi executor.
- [The Node 22.19 minimum breaks existing server hosts] → Document it in `docs/server-backend.md` and `AGENTS.md`, and fail fast at server startup with a clear message when the Node version is too old.
- [Pi and the Responses adapter handle models differently, for example the Codex endpoint or tool-call formats] → Build the model runtime from the shared `runtime-auth` module already proven on the desktop for both credential shapes, and add contract tests per credential kind.
- [Local mode gains source filtering, so citations the model could not verify disappear] → This is intended parity. It is covered by a scenario and noted in release notes.
- [Rehydrating through temporary files costs I/O per turn] → Transcripts stay bounded (Decision 10) and the file is written once per attempt.
- [The replacing result event is a new synchronization shape] → Version the event (v2), keep the v1 reader, and cover replay, undo and conflicts with contract tests before enabling replies in server mode.

## Migration Plan

1. Land `packages/pi-runtime` and switch the sidecar to it, with no user-visible change except the prompt and citation parity.
2. Add migration `0006_call_conversations.sql` (the new table and columns, all nullable or defaulted; no backfill).
3. Switch `ServerAgentRunner` to `runPiTurn` behind a server config flag (`agent.engine = pi | legacy`, default `pi`). Keep `runAgent` for one release as the rollback path.
4. Enable server replies. Desktops that send the intent without `conversation` keep working.
5. Remove `runAgent`, `OpenAIResponsesModelAdapter` and the flag in the following release.

Rollback: set `agent.engine = legacy`. Stored turns are ignored by the legacy engine, and replies to server calls are refused with `conversation_unavailable` until Pi is re-enabled.

## Open Questions

- Exact defaults for the per-call transcript budget and owner age limit. They can be tuned after measuring real transcripts without changing the approach.
