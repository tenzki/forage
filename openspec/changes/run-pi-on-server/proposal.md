## Why

Forage runs two different agent loops: the desktop sidecar runs the Pi SDK, and the server runs `runAgent` from `packages/agent-runtime` with a direct OpenAI Responses adapter. They differ in prompt composition, how a run may end, in-run history, source-citation rules and context management, so the same skill behaves differently depending on storage mode. ADR-0022 makes Pi the shared engine. Server-mode call conversations (replies that resume the agent's transcript) also need that engine.

## What Changes

- Move Pi session setup out of the desktop sidecar into a shared Node package used by both the sidecar and the server: prompt composition, effective tool set, `emit_outline`, final-response and outcome handling, activity mapping, limits, model runtime authentication and a conversation-store interface.
- **BREAKING (internal):** the server executes admitted runs, both manual and Inbox automation, with Pi sessions instead of `runAgent` and `OpenAIResponsesModelAdapter`. Admission (ADR-0019), compute resolution (ADR-0018), leases, retries, cancellation and atomic placement (ADR-0020) are unchanged.
- Server tools (web read/fetch, X read, YouTube transcript, web search, outline search, image generation) become Pi tools with their existing bounds and URL protections.
- Unify prompt rules across environments. Both now treat fetched and captured material as untrusted, cite only URLs returned by successful source-reading tools, and return results through `emit_outline`. Local runs gain the verified-citation rule and source filtering the server already applies.
- Add server-mode call conversations. Replies to a server call resume its transcript, which is stored in PostgreSQL. The agent answers inline or produces a replacing version, and any connected device can continue the call.
- Extend the manual invocation intent with a call identity and turn, and allow only one active turn per call.
- Add a result-commit event variant that replaces the previous version's generated nodes in the same atomic placement.
- Retire the `runAgent` loop and `OpenAIResponsesModelAdapter`. `packages/agent-runtime` keeps the shared contracts. The Inbox dispatcher classifier stays a single direct model call.
- Raise the documented Node.js requirement for the desktop sidecar and the server to Pi's minimum (22.19).

## Capabilities

### New Capabilities

- `agent-runtime-parity`: one agent loop with the same prompt rules, tool policy, limits, source verification and outcomes in local and server execution.
- `server-call-conversations`: server-mode call conversations, covering transcript storage in PostgreSQL, resume across devices, retry safety, replacing placement and lifecycle.

### Modified Capabilities

None in `openspec/specs/`. This change depends on `add-agent-call-conversations` (the `agent-call-conversations` capability) and updates the unarchived `add-server-agent-executor` design (see ADR-0022). When `add-agent-call-conversations` is archived first, its "Legacy single-shot steering" requirement is narrowed here so that server-mode calls no longer use single-shot steering (see design.md, Decision 9).

## Impact

- New package (`packages/pi-runtime`) that takes a dependency on `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`. The sidecar now uses it, and it becomes a new server dependency.
- `apps/server`: `serverRunner.ts`, `serverTools.ts`, `main.ts` wiring, `repository.ts` / `postgresAgentStore.ts`, a new migration (`0006_call_conversations.sql`), and the run observation APIs, which gain answers and call identity.
- `packages/protocol`: manual intent version with `conversation`, run views with call identity and answers, and a `agent.result_committed` variant that replaces a previous version.
- `packages/agent-runtime`: `runAgent`, `composeAgentPrompt` and the model adapter types are removed. Contracts stay.
- Desktop: server run manager and activity for server calls, and replay of the replacing result event.
- Docs: ADR-0022 accepted, ADR-0013 marked superseded in part, `docs/architecture.md`, `docs/server-backend.md`, and the Node requirement in `AGENTS.md`.
