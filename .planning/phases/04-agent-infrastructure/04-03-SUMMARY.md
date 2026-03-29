---
phase: 04-agent-infrastructure
plan: 03
subsystem: agent-ux
tags: [tiptap, slash-commands, zustand, context-building, summarization, token-budget]

requires:
  - phase: 04-agent-infrastructure
    plan: 01
    provides: agentCommandIpc bridge, sidecar JSONL RPC, agent-event Tauri channel

provides:
  - SlashCommand TipTap extension with '/' trigger and URL false-positive guard
  - SKILLS registry (ask, research, brainstorm) with outputMode declarations
  - agentStore Zustand store: invokeSkill, buildContextMessages, appendToken, cancelGeneration
  - Context summarization pipeline: tokens/4 heuristic, 100k threshold, sidecar summarize call
  - SlashCommand wired into NodeEditor with configure() callback pattern

affects:
  - 04-04 (streaming — appendToken/finalizeGeneration stubs ready for full wiring)
  - NodeEditor (SlashCommand extension now in extensions array)

tech-stack:
  added: []
  patterns:
    - TipTap Suggestion extension with allow() callback for URL false-positive guard
    - Slash command with allowSpaces:true for args after skill name
    - Zustand store with Map<string, ActiveGeneration> keyed by nodeId
    - One-shot agent-event listener with requestId correlation for summarization
    - chars/4 token heuristic (no tokenizer dependency)

key-files:
  created:
    - src/extensions/SlashCommand.tsx
    - src/extensions/SlashCommand.test.tsx
    - src/store/agentStore.ts
    - src/store/agentStore.test.ts
  modified:
    - src/store/ipc.ts
    - src/components/Outliner/NodeEditor.tsx
    - src/style.css

key-decisions:
  - "shouldAllowSlash checks preceding char === ':' to prevent URL false positives (https:// won't trigger popup)"
  - "Suggestion allowSpaces:true so '/research quantum computing' captures full query including args"
  - "estimateTokens uses chars/4 heuristic — no tokenizer dependency, sufficient for budget estimation"
  - "summarizeOlderMessages fallback to recentMessages on timeout/error — graceful degradation over hard failure"
  - "agentStore.activeGenerations keyed by nodeId (not ghostNodeId) — prevents duplicate invocations per-node"
  - "SlashCommand configured via configure() callback to use nodeRef.current — same stale closure avoidance pattern as OutlinerKeys"

duration: 4min
completed: 2026-03-29
---

# Phase 04 Plan 03: Slash Command Extension and Agent Store Summary

**TipTap slash command extension with skill autocomplete popup, URL false-positive guard, and Zustand agentStore with ancestor context building and token-budget summarization via sidecar**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-03-29T07:06:05Z
- **Completed:** 2026-03-29T07:10:14Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Created `SlashCommand` TipTap extension following HashtagNode pattern with `'/'` trigger, `allowSpaces: true` for arguments, and `allow()` callback blocking `:` predecessors to prevent URL false positives
- Implemented `SKILLS` registry with ask/research/brainstorm entries, exported `filterSkills`, `shouldAllowSlash`, and `parseSlashInput` pure functions with 14 unit tests
- Created `agentStore.ts` Zustand store with `invokeSkill` (builds context, creates ghost node, dispatches to sidecar), `buildContextMessages` (maps ancestor chain to user/assistant messages by `node_type`), `estimateTokens` (chars/4 heuristic), and `summarizeOlderMessages` (one-shot `agent-event` listener pattern with requestId correlation)
- Added `agentCommandIpc` to `ipc.ts` as the fire-and-forget JSONL bridge
- Wired SlashCommand into NodeEditor with `.configure({ onSkillInvoked })` pattern
- 23 total unit tests passing (14 slash command + 9 agent store)

## Task Commits

Each task was committed atomically:

1. **Task 1: SlashCommand TipTap extension** - `4e78037` (feat)
2. **Task 2: agentStore with context building and NodeEditor wiring** - `e438f0b` (feat)

## Files Created/Modified

- `src/extensions/SlashCommand.tsx` — TipTap Node extension with Suggestion, URL guard, skill popup
- `src/extensions/SlashCommand.test.tsx` — 14 unit tests for filterSkills/shouldAllowSlash/parseSlashInput
- `src/store/agentStore.ts` — Zustand store: invokeSkill, buildContextMessages, summarizeOlderMessages
- `src/store/agentStore.test.ts` — 9 unit tests: context mapping, token estimation, summarization
- `src/store/ipc.ts` — Added agentCommandIpc (fire-and-forget JSONL bridge)
- `src/components/Outliner/NodeEditor.tsx` — SlashCommand extension added to TipTap extensions array
- `src/style.css` — .slash-suggestion-popup styles with two-line item layout

## Decisions Made

- `shouldAllowSlash` checks `precedingChar === ':'` specifically — simple and robust against the primary false-positive case (URLs like `https://`)
- `allowSpaces: true` in Suggestion config enables full command capture (`/research quantum computing` as single suggestion)
- `estimateTokens` uses chars/4 (no tokenizer dependency) — conservative enough for budget gating without adding a library
- Summarization fallback: on timeout or error, `summarizeOlderMessages` returns `recentMessages` slice rather than failing the whole invocation
- `activeGenerations` Map keyed by `nodeId` (triggering node) — prevents duplicate skill invocations per research note

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] agentCommandIpc already added to ipc.ts by plan 04-02**
- **Found during:** Task 2 setup
- **Issue:** ipc.ts already contained agentCommandIpc from a prior plan session (04-02), no addition needed
- **Fix:** No action required — verified existing implementation matches plan spec
- **Impact:** None

**2. [Rule 1 - Bug] Summarization test timeout — event listener race condition**
- **Found during:** Task 2 TDD GREEN verification
- **Issue:** agentStore test for summarization timed out (5000ms) because mock `listen()` captured callback but test couldn't inject synthetic event without explicit coordination
- **Fix:** Updated mock to capture `capturedEventCallback` ref, test injects summary event with matching requestId after yielding via `setTimeout(resolve, 10)`
- **Files modified:** src/store/agentStore.test.ts
- **Verification:** 9/9 tests pass

**3. [Rule 1 - Bug] Test assertion wrong for summarization result length**
- **Found during:** Task 2 TDD iteration
- **Issue:** With 5 messages and RECENT_MESSAGES_TO_KEEP=4, replacing 1 older message with 1 summary still yields 5 messages total; test incorrectly expected `< messages.length`
- **Fix:** Updated assertion to `toHaveLength(5)` and verify structure (first message contains `[Context summary]`)
- **Files modified:** src/store/agentStore.test.ts
- **Verification:** Test passes

---

**Total deviations:** 3 (1 non-issue, 2 test bugs)
**Impact on plan:** All fixes were in test logic, not implementation. Production code matches plan spec exactly.

## Issues Encountered

- Pre-existing TypeScript errors in `src/lib/bindings.ts` (TAURI_CHANNEL, __makeEvents__ unused) — present before this plan, not introduced by changes

## Next Phase Readiness

- SlashCommand popup triggers on `'/'` in any node, filters skills by prefix, fires `onSkillInvoked` callback
- agentStore.invokeSkill creates ghost child node, stores command metadata, dispatches `prompt` command to sidecar
- appendToken/finalizeGeneration placeholders ready for Plan 04 streaming wire-up
- cancelGeneration sends `abort` to sidecar

---
*Phase: 04-agent-infrastructure*
*Completed: 2026-03-29*

## Self-Check: PASSED

- SlashCommand.tsx: FOUND
- SlashCommand.test.tsx: FOUND
- agentStore.ts: FOUND
- agentStore.test.ts: FOUND
- 04-03-SUMMARY.md: FOUND
- Commit 4e78037 (Task 1): FOUND
- Commit e438f0b (Task 2): FOUND
