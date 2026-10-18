# ADR-0026: Run Admitted Agent Work on Pi Durable

- **Status:** Accepted
- **Date:** 2026-10-18
- **Supersedes:** ADR-0022 (Pi agent loop) in part: SDK sessions and per-attempt transcript rollback

## Decision

Use the pinned `@earendil-works/pi-durable` 1.3.0 Harness for both the local sidecar and the server's Pi engine. The shared `packages/pi-runtime` adapter preserves Forage's prompts, exact provider selection, tool admission, limits, activity vocabulary, structured output and answer outcomes. Node.js 22.19 or later is required in both environments.

Forage remains the authority for admission, credentials, run identity, outline state, assets, result validation, placement and history. Pi Durable owns internal conversations, submissions, generation/tool tasks and execution checkpoints. Its documents never become a second outline model. Helper agents, steering queues and other new product workflows are outside this migration.

## Storage and ownership

Local calls use `<appData>/pi-agent/agent-sessions/<callId>.sqlite`. The sidecar holds an exclusive SQLite connection for the lifetime of an execution, with WAL and `synchronous=FULL`. It closes the Harness before publishing its terminal IPC event. SQLite releases ownership after process death. The native history lifecycle prunes orphan databases, WAL/SHM files and legacy JSONL files.

The server stores a per-call journal in PostgreSQL (`agent_durable_calls`, `agent_durable_commits`, migration 0008). Pi's reference storage validates and materializes records; each prepared commit is persisted before application and publication. Identifiers are reserved durably and never reused. Like Pi's JSONL backend, this implementation materializes retained history in memory. Each call's journal is bounded to 32 MiB; the existing settled transcript admission budget remains 2 MiB. Finished-history clearing and transcript age retention also remove the corresponding execution journals.

Every server checkpoint, identifier allocation and external execution boundary checks the admitted run's worker lease. A persisted execution nonce and attempt number fence duplicate executors and workers whose leases expired, including when a worker identifier is reused. PostgreSQL remains the durable server authority; server recovery does not depend on a host filesystem.

Execution checkpoints are required state while work is unfinished. They must be included in backups. They must not be discarded as a transcript cache during an active run.

## Recovery and effects

A Forage run maps to an idempotent Durable submission and its own conversation. New successful turns fork from the last successful conversation. Failed and cancelled runs do not enter the next reply's context, while their execution records remain available for recovery and inspection. An immutable request fingerprint prevents a recovered run from changing its prompt, model or admission snapshot. A server retry continues the same run with its completed tool receipts and remaining budget, rather than replaying the whole turn. A completed result is recoverable without another model request, including after a crash before Forage settles it.

Built-in source reads declare safe replay. MCP, custom HTTP and extension tools default to unsafe replay: an interrupted call receives an interrupted result rather than automatic execution. External effects are not exactly-once; tools that need that guarantee must implement operation identities and reconciliation. Source verification, generated image references and consumed tool rounds persist with execution state. Extension start/end hooks record intent and completion; an uncertain start fails closed and an uncertain end is not repeated.

Desktop process shutdown suspends the Harness without aborting its tasks; explicit user cancellation remains terminal. Native startup requeues only runs explicitly admitted with `runtime: 'pi-durable'`. Older SDK runs and generic extension executors keep their interrupted behavior. Startup recovery uses the original input and credential references, reacquires current authorized resources, and resolves the canonical editor rather than a pane. A closed editor or missing destination retains completed output for later placement.

Local outline results are retained as `completed_unplaced` before document placement. The final canonical transaction uses `agent-result:<runId>` as its change group. Native event append settles the corresponding local run in the same SQLite transaction, so reopening cannot insert a placed result twice. Server results continue through the existing atomic `agent.result_committed` path.

## Upgrade compatibility and secrets

Existing local SDK JSONL conversations import on their first resumed turn; their source files remain unchanged. Existing server transcript entries can seed a new Durable call journal. Missing or corrupt conversation history fails closed. Calls stay in their originating execution environment.

Only the admitted model provider is registered. Credentials remain environment-owned and in memory. Prompts, imported entries, tool results and model streams are redacted before they reach the Harness, including live partials. Checkpoint formats and runtime versions are pinned; upgrades require the storage conformance, crash recovery, tool policy, conversation and placement regressions.

## Verification

Automated coverage includes the upstream storage conformance suite, forced child-process termination during safe/unsafe tools and after completed reads, exclusive local ownership, legacy import, server lease handoff and duplicate-executor fencing, native startup recovery and atomic local placement. Native visual startup/activity/recovery checks remain manual because this repository prohibits computer use and unrequested browser automation.
