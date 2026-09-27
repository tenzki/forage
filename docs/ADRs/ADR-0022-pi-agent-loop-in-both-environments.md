# ADR-0022: Run the Pi Agent Loop Wherever Agents Execute and Persist Call Conversations There

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Forage maintainers
- **Supersedes:** ADR-0013 in part (in-memory-only sessions; a server runtime separate from Pi)
- **Superseded by:** None

## Context

Forage executes agents in two places, selected by storage mode:

- **Local mode:** the desktop runs agents in the Node.js sidecar, which embeds the Pi SDK (ADR-0013).
- **Server mode:** the server admits runs from invocation intents (ADR-0019), resolves compute (ADR-0018) and commits results atomically (ADR-0020). It executes them with `runAgent` from `packages/agent-runtime` and a direct OpenAI Responses adapter (`apps/server/src/serverRunner.ts`, `apps/server/src/serverModel.ts`).

The server-executor design (`openspec/changes/add-server-agent-executor/design.md`) intended one shared loop, with the desktop Pi sidecar becoming an adapter of `packages/agent-runtime`, because "prompt composition, tool authorization, output validation, cancellation, and limits must be identical". That migration never happened. Forage now runs two agent loops that differ in prompt construction, tool-call handling, how a run may end (the server loop cannot end with a text answer), in-run history (the server keeps tool calls and results only) and context management (the server has no compaction).

The gap now blocks a product requirement. Replies in the activity panel must continue the same agent conversation, answering questions inline or producing a replacing version (`openspec/changes/add-agent-call-conversations`). That needs a durable, resumable transcript per call in both environments. Building conversations twice, on two different loops, would widen the divergence.

ADR-0013 also chose in-memory Pi sessions "to avoid coupling the outline to Pi session persistence". Conversations require persistence, but only of the agent transcript, never of outline data.

## Decision Drivers

- Local and server execution must behave identically for the same agent, skill, tools and context.
- Execution location follows storage mode: server mode runs on the server, local mode runs on the device, with no cross-fallback.
- A skill call must be resumable as a conversation from its full transcript in either environment.
- Long conversations must stay within model context limits.
- The PostgreSQL server remains authoritative in server mode; server state must not depend on local files on a server host.
- Credentials never enter prompts, transcripts, run snapshots or activity (ADR-0018).
- Existing server guarantees stay intact: intent admission (ADR-0019), durable concurrent runs and atomic placement (ADR-0020).

## Considered Options

1. **Pi everywhere.** The server runs the same Pi agent loop as the sidecar. Transcripts are stored in each environment's own store.
2. **`runAgent` everywhere.** Complete the original plan: the desktop sidecar becomes an adapter of `packages/agent-runtime`'s loop, and conversations are built once into `runAgent`.
3. **Keep two loops.** Add conversation history separately to the Pi sidecar and to `runAgent`.

## Decision

We will **use the Pi SDK agent loop in both execution environments and persist each skill call's conversation in the store owned by the environment that executes it** because **Pi already provides the transcript, resume and compaction model that conversations need, and one loop is the only way to keep local and server behavior identical**.

- **Where agents run.** In server mode, the server runs Pi sessions for admitted runs, replacing `runAgent` and `OpenAIResponsesModelAdapter`. In local mode, the sidecar runs Pi as today. Admission, compute resolution, run durability, cancellation and result placement stay as ADR-0018, ADR-0019 and ADR-0020 define them.
- **One shared session setup.** Session construction (system-prompt composition, effective tool set, `emit_outline`, final-response and outcome handling, limits) moves into a shared Node package used by the sidecar and the server. Each environment supplies only adapters: credentials and model runtime, environment-specific tools (for example local extensions and Codex subscription images locally; server tools and server image generation on the server), and a conversation store.
- **Conversation stores.** A call's transcript is stored where it executed:
  - local mode: Pi JSONL session files under application data, keyed by call identity;
  - server mode: PostgreSQL rows of Pi session entries, owned by the outline owner and tied to the call's runs, loaded into an in-memory Pi session to resume and appended in the same transaction that settles the run.
- **What a transcript holds.** Agent messages, tool calls and tool results only. Transcripts are an agent cache, never outline data. The outline changes only through the existing result and placement paths.
- **No cross-environment resume.** A call continues only in the environment that started it. A local call is not resumed on the server and vice versa.
- **Scope of `packages/agent-runtime`.** It keeps the shared contracts (agent, skill, run input, activity, structured results, the answer outcome). Its `runAgent` loop is retired once server execution runs on Pi.

## Consequences

### Positive

- One agent loop, so prompts, tool authorization, output validation and limits cannot drift between modes.
- Conversations are built once, on Pi's session model, and work in both modes.
- The server gains Pi's automatic compaction and the ability to end a turn with a text answer.
- Server conversations live in PostgreSQL, so any connected device can continue a call and server hosts stay free of durable local files.
- The server keeps its existing admission, durability and placement guarantees.

### Negative

- The server takes a runtime dependency on the Pi SDK and follows its upgrade cadence. Both environments must be retested on Pi upgrades.
- Server tools, limits and the Responses-specific behavior (structured-output format, Codex endpoint handling) must be ported into Pi tools and the Pi model runtime.
- Two conversation store backends (local files, PostgreSQL rows) must follow the same lifecycle rules.
- Transcripts store tool results in plaintext at rest, including fetched pages and custom HTTP responses.
- Local-mode transcripts live outside the SQLite event store, an explicit exception to the SQLite durability boundary of ADR-0012 and ADR-0014, limited to a derived agent cache.

### Risks and Mitigations

- **Risk:** Pi's session format changes between SDK versions and old transcripts stop loading.  
  **Mitigation:** pin the SDK in both environments. Resume fails closed with a clear "run the skill again" message instead of starting a silent fresh session. Contract tests load a stored transcript fixture on every upgrade.
- **Risk:** Server transcripts grow without bound in PostgreSQL.  
  **Mitigation:** Pi compaction stays enabled. Transcripts are deleted with their calls' finished history, and a per-owner size or age limit is enforced.
- **Risk:** A credential or secret leaks into a stored transcript.  
  **Mitigation:** credentials reach Pi only through the model runtime and child environment, never through messages or tool arguments. Known secret values are redacted from stored tool results.
- **Risk:** Porting the server loop changes behavior users rely on (limits, error codes, provider handling).  
  **Mitigation:** carry over the existing `runAgent` and `serverModel` tests as behavior tests against the Pi-based server executor before retiring the old loop.

## Option Analysis

### Option 1: Pi everywhere

**Advantages**

- Reuses working desktop behavior, including sessions, compaction, streaming and tool events.
- Conversations and answer outcomes are implemented once.
- Matches the stated goal of identical runtimes.

**Disadvantages**

- The server depends on the Pi SDK.
- Server tools and model handling must be ported.

### Option 2: `runAgent` everywhere

**Advantages**

- Forage owns the loop end to end, with no third-party loop on the server.
- Matches the original `add-server-agent-executor` plan.

**Disadvantages**

- Reworks the working desktop sidecar and gives up Pi's loop features.
- Transcripts, resume, compaction and text answers must be built from scratch.

### Option 3: Keep two loops

**Advantages**

- Fastest path to conversations in each mode separately.

**Disadvantages**

- Builds two conversation systems and deepens behavioral divergence.
- Every future agent feature must be implemented and tested twice.

## Implementation Notes

- Local conversations (`openspec/changes/add-agent-call-conversations`) can land first. Session opening goes through one function keyed by call identity, so the server can supply its own store.
- `openspec/changes/run-pi-on-server` moves Pi session setup into a shared package, replaces `runAgent` in `serverRunner.ts`, ports server tools, adds a PostgreSQL conversation table with a migration, and extends the manual invocation intent (ADR-0019) with call identity and turn for replies.
- `openspec/changes/add-server-agent-executor/design.md`'s shared-runtime decision is superseded by this ADR and must be updated to point here.
- Local conversations are implemented: the sidecar stores `<appData>/pi-agent/agent-sessions/<callId>.jsonl` (`packages/pi-runtime/src/conversation-store.ts`), and `apps/desktop/src-tauri/src/agent_sessions.rs` deletes a call's file once no run of that call remains, on history clear and at startup. Server execution still uses `runAgent` until `run-pi-on-server` lands.

## Validation

- The same skill, agent, tools and context produce equivalent prompts, tool sets and outcomes in local and server mode (shared-package tests plus one end-to-end comparison per mode).
- A reply resumes the call's transcript in both modes. A missing transcript fails closed.
- Server transcripts are written in the same transaction that settles the run and are deleted when finished history is cleared.
- No credential value appears in stored transcripts, run snapshots or activity (redaction tests).
- Existing server admission, idempotency, cancellation and atomic-placement tests pass on the Pi-based executor.
- Reconsider if the Pi SDK's session model or licensing stops meeting server requirements.

## References

- [ADR-0012: Use an Event Store with an Optional Self-Hosted Server](ADR-0012-event-store-and-optional-server.md)
- [ADR-0013: Embed the Pi SDK in a Local Node.js Sidecar](ADR-0013-embedded-pi-sdk-sidecar.md)
- [ADR-0014: Store Local Credentials in the SQLite Event Store](ADR-0014-local-credentials-in-sqlite.md)
- [ADR-0018: Resolve Models and Credentials Through Environment Compute Profiles](ADR-0018-environment-compute-profiles.md)
- [ADR-0019: Admit Server Agents From Invocation Intents](ADR-0019-intent-based-server-agent-admission.md)
- [ADR-0020: Keep Agent Runs Concurrent and Commit Results Atomically](ADR-0020-concurrent-agents-and-atomic-results.md)
- [Add agent call conversations](../../openspec/changes/add-agent-call-conversations/proposal.md)
- [Add server agent executor — design](../../openspec/changes/add-server-agent-executor/design.md)
