## Why

Replying to a skill call in the activity panel starts a brand-new agent session whose only memory is a rebuilt prompt: the original request, the latest note and a flattened text copy of the current output. The agent loses its earlier research, tool results and reasoning, earlier replies, link targets, generated images and the user's own bullets under the invocation, and every reply is forced to rewrite the outline even when the user only wanted to ask a question.

## What Changes

- A local skill call becomes a persistent conversation. The first run creates a Pi session file keyed by a stable call identity; each reply resumes that session and sends the reply as the next user turn, so the agent keeps its full prior transcript.
- Every follow-up turn also carries a freshly resolved outline context, so edits made since the previous turn — including the user's own bullets under the invocation — are visible.
- The agent decides per reply whether to answer or revise:
  - a plain-text response is shown inline in the call's thread and leaves the outline untouched;
  - an `emit_outline` result becomes the next version and replaces the previous version's agent output.
- The outline is changed only when a revision actually completes. A failed or cancelled reply leaves the previous version in place (today the output is removed before the rerun starts).
- Inline answers are persisted with the call and survive an app restart.
- Calls are grouped by the stable call identity instead of by matching bullet and label.
- Clearing activity history deletes the corresponding session files; orphaned session files are pruned.
- Server-mode calls, extension-backed skills and calls recorded before this change keep the current single-shot steering behavior.

## Capabilities

### New Capabilities

- `agent-call-conversations`: follow-up replies to a local skill call that resume the call's agent conversation, answer inline or produce a replacing version, and persist the thread.

### Modified Capabilities

None. No existing spec covers activity-panel steering.

## Impact

- Sidecar (`apps/desktop/src-tauri/resources/pi/sidecar/index.ts`): persistent `SessionManager.create` / `open` instead of `inMemory`, resume payload, follow-up message format and system-prompt addendum, answer-vs-outline outcome in `agent_settled`.
- Agent runtime contracts (`packages/agent-runtime`): optional `thread` on the local run input; a local answer outcome alongside structured results.
- Desktop agent flow: `App.tsx` `steerCall`, `SlashMenu.runSkill`, `piLocalRunner`, `localExecutor`, `piGeneration`, `skillCalls` / `activityCalls` grouping and thread items, `ActivitySidebar` rendering of answers and streaming.
- Native persistence: deleting and pruning session files under application data alongside agent run history.
- Storage: a new per-call JSONL session store under application data, outside the SQLite event store. Documented in an ADR.
- Server executor, extension skill execution and PostgreSQL: unchanged.
