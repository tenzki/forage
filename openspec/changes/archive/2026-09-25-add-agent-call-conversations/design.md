## Context

See proposal.md for motivation. Current mechanics that shape the approach:

- `steerCall` (`apps/desktop/src/App.tsx`) removes the agent output via `takeAiOutput`, builds a text prompt with `steeredPrompt` (`agent/skillRuns.ts`) and dispatches `outline:run-skill`. `SlashMenu.runSkill` handles it as a new slash run with a new `runId`.
- The sidecar creates `SessionManager.inMemory()` per run, sends one `session.prompt(taskMessage(payload))` and disposes the session.
- When a run ends without `emit_outline`, `piLocalRunner` converts the final text into outline bullets (`textNodes`), and `runSkill` streams text deltas into a live AI bullet under the invocation.
- Versions are grouped heuristically by `nodeId + label` (`groupSkillCalls`); steering notes are recovered by parsing the stored prompt (`parseSteeredPrompt`).
- The sidecar already receives `appDataDir()` as `PI_CODING_AGENT_DIR`. Rust stores run snapshots and results as opaque JSON.
- Pi (`@earendil-works/pi-coding-agent` 0.84.2) persists sessions as JSONL through `SessionManager.create(cwd, sessionDir)` / `SessionManager.open(path, sessionDir, cwdOverride)` and compacts long sessions automatically (compaction is enabled by default).
- Server mode does not run Pi; `apps/server` has its own model loop.

## Goals / Non-Goals

**Goals:**

- A reply continues the same agent conversation with its full transcript.
- The agent chooses between an inline answer and a replacing revision.
- The outline changes only when a revision completes.
- Answers and versions render as one persisted thread per call.

**Non-Goals:**

- Server-mode conversations. Direction: execution location follows storage mode. In server mode, Pi runs on the server (replacing the `runAgent` loop and the Responses adapter) and call transcripts are stored in PostgreSQL. In local mode, Pi runs in the sidecar with transcripts on the device. `openspec/changes/run-pi-on-server` covers the server side against the same `agent-call-conversations` requirements.
- Conversations for extension-backed skills (they do not run Pi).
- An explicit Ask/Revise toggle or an "Add answer to outline" action. The user can ask the agent to put an answer into the outline, which produces a revision.
- Branching from an earlier version. Pi session trees make this possible later.
- Syncing session transcripts across devices.

## Decisions

### 1. Pi JSONL session files keyed by call identity

The first run of a call creates `<appData>/pi-agent/agent-sessions/<callId>.jsonl` (under `PI_CODING_AGENT_DIR`). Replies resume the same file. The path is derived only from `callId`, which is validated against the runtime ID charset; the payload never carries a path.

The sidecar opens the file with `SessionManager.open(path, sessionDir, process.cwd())` in both modes, because `create` names files `<timestamp>_<sessionId>.jsonl`. For turn 1, `open` on a missing path starts a new session at that path, and any stale file from an interrupted first attempt is removed first. Pi writes the file once the first assistant message exists and only appends afterwards, so a turn that fails or is cancelled is rolled back by truncating the file to its size before the turn (or deleting it on turn 1). The next reply resumes from the last completed turn.

Session creation and resumption go through one small function (open a session for a `callId` in new or resume mode) instead of calling `SessionManager` inline. That lets the server-side Pi runtime supply a PostgreSQL-backed store (an in-memory session whose entries are loaded from and appended to rows) without changing the turn logic.

Alternative considered: keep in-memory sessions, return the new session entries after each turn, store them in a SQLite table and replay them into an in-memory session on resume. That keeps a single durable store but needs bigger stdin payloads (the current limit is 512 KB), a reimplementation of Pi's entry handling and more native commands. Session transcripts are a derived agent cache, not outline data, so a file store is acceptable. An ADR records this exception to "SQLite owns durability" (ADR-0012/0014).

### 2. Stable call identity on the run snapshot

Add an optional `thread: { callId, turn }` to the local `RunInput`. The first run uses `callId = runId, turn = 1`; a reply uses the same `callId` with the next turn number and its own `runId`. `groupSkillCalls` groups by `thread.callId` when present and falls back to the `nodeId + label` heuristic for older history. The activity header, versions and answers all hang off the call.

A reply's run snapshot stores the reply as `prompt`, the call's first prompt as `source.text`, and the invocation subtree lines as `invocationOutline` (accepted only on turns after the first). Turn numbers grow monotonically per call. A reply to a call with no completed turn (its first turn failed or was cancelled, so no session remains) starts the conversation over as turn 1, with the note folded into the first prompt. A turn that ends with neither text nor an outline is rolled back like a failed turn, so the desktop's empty-response retry does not duplicate the reply in the transcript. A reply to a local call while the app is in server mode is refused, because the conversation is stored on the device.

### 3. Follow-up turn content

A resumed turn sends one user message:

```
Selected outline context (hierarchy preserved by indentation):
<fresh context>

Outline under the invocation bullet:
<current children of the invocation, marking agent-written bullets>

User follow-up: <reply text>
```

The fresh context uses the same `resolveAgentContext` resolver and budget as a first run. The invocation's subtree is listed separately (bounded by the same budget) because the resolver excludes it, and the agent needs to see the current output and any bullets the user added.

The system prompt is rebuilt every turn from the current agent settings, with one addendum for follow-up turns: answer questions in plain text without calling `emit_outline`; when the user asks to change, extend or replace the result, call `emit_outline` with the complete replacement. Tools and model are also taken from current settings; Pi records model changes in the session.

### 4. Turn outcome: answer or outline

The sidecar's `agent_settled` event carries `outcome: 'outline' | 'text'` (whether `emit_outline` completed in this turn). On follow-up turns:

- **Outline:** handled as today, except that replacement happens at commit time. Agent output means `ai` list items and generated-image items directly under the invocation; the new result takes the place of the first of them (or goes last), so user bullets keep their position. `replaceAiOutput` removes the previous agent output and inserts the new result in one editor transaction, which is its own undo step; the removed output is recorded with `recordReplacedOutput` for superseded-version display.
- **Answer:** the final assistant text becomes a local answer outcome (`{ version: 1, type: 'answer', text }`, at most 20,000 characters). It is stored as the run's result and is never converted into outline bullets.

During a follow-up turn, text deltas stream into the thread, not into a live outline bullet, because the outcome is unknown until the turn ends. The first turn keeps today's behavior, including the text-to-bullets fallback.

The answer outcome is a local-only schema next to `structuredResultSchema`, not a new union member. That keeps the server's result validation unchanged; the local executor and history readers discriminate on `type`.

### 5. Thread model

`skillCallThread` produces, per turn in order: the user's reply (`note`), grouped tool activity, then either an `answer` item or an `output` version item. Version numbers count only outline-producing turns. History reload (`callsFromHistory`) reads the reply text from `thread`-aware snapshots (the prompt is no longer a rebuilt steering prompt) and answers from the stored answer outcome.

### 6. Legacy steering path

Calls without `thread` (server mode, extension skills, history from before this change) keep the current `steeredPrompt` behavior. `steerCall` picks the path by checking whether the call's latest run snapshot has `thread`.

### 7. Session file lifecycle

- The native history clear (`agent_runs_clear`) then deletes every session file whose `callId` has no remaining run row, so calls with a retained unplaced result keep their files. File deletion is best effort: the history stays cleared if a file cannot be removed, and the next startup removes it.
- At startup, before any run can start, session files whose `callId` has no remaining run row are deleted (`agent_sessions.rs`). Only regular files named `<callId>.jsonl` with a valid call ID are touched.
- Resuming with a missing or unreadable file fails the reply with "This conversation's history is no longer available. Run the skill again to start a new one." There is no silent fresh-session fallback, which would look like a working conversation that has forgotten everything.

## Risks / Trade-offs

- [Tool results are stored in plaintext session files, including custom HTTP and extension tool responses] → Files live in the app data directory with the same trust level as the SQLite store, which already keeps results and activity. Credentials are passed through the environment and never enter messages. Documented in the ADR.
- [The agent answers when the user wanted a revision, or the reverse] → The system-prompt addendum is explicit, and a follow-up ("put that in the outline") corrects it without data loss, because answers never touch the outline.
- [Generated-image IDs from earlier turns are not in the new turn's image map] → Images from earlier turns are already placed as assets. The addendum tells the agent that earlier images are placed, and `emit_outline` rejects unknown image IDs with a clear tool error the agent can recover from.
- [Session growth] → Pi auto-compaction stays enabled. Each turn's outline context stays within the existing 100-node / 40,000-character budget.
- [The outline changes between turns in ways that conflict with the agent's memory] → Every turn carries fresh outline context, which takes precedence in the follow-up message.
- [Two stores for one call (SQLite runs and JSONL session)] → The session is treated as a cache keyed by run rows: pruned when rows disappear, and resume fails closed when the file is missing.

## Migration Plan

No data migration. Existing history renders through the heuristic grouping and keeps legacy steering. New local calls get `thread` and a session file. The run-history reader (`eventStore.ts`, which strictly re-parses snapshots and results) accepts the optional `thread` field and the answer outcome.

Rollback: older builds strictly reject run rows that contain `thread` or an answer outcome when loading activity history. Downgrading therefore requires clearing agent activity history first. Session files are ignored by older builds and removed by the next clear after re-upgrading.
