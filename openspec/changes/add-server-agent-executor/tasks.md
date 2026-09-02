## 1. Shared Agent Contracts and Runtime

- [x] 1.1 Create `packages/agent-runtime/package.json`, TypeScript configuration, exports, and workspace-layout coverage without React, Tauri, Fastify, PostgreSQL, or browser dependencies
- [x] 1.2 Move runtime-validated agent, skill, required-tool, custom-tool, activity-event, run-input, run-status, configuration-revision, and structured-result schemas from `apps/desktop/src/agent` into `packages/agent-runtime`
- [x] 1.3 Add validation for unique IDs, referential integrity, bounded prompts/descriptions, required tools, executor-supported tools, credential references, node depth/count/text limits, and secret-free serialized snapshots
- [x] 1.4 Implement the injected model/tool loop, prompt composition, cancellation propagation, activity emission, tool-round limits, and mandatory structured-result termination in `packages/agent-runtime`
- [x] 1.5 Implement effective-tool resolution as the intersection of agent, skill, global, policy, and executor capability sets, with preflight rejection of unavailable required tools
- [x] 1.6 Add shared contract fixtures and tests proving deterministic configuration parsing, tool authorization, cancellation, untrusted-source labelling, output bounds, and equivalent local/server runtime behavior

## 2. Domain Events and Wire Protocol

- [x] 2.1 Extend `packages/domain/src/envelope.ts` with the `agent` origin and bounded run/skill/source provenance needed by server-generated output, then update parser, upcaster, replay, and immutability tests
- [x] 2.2 Add `packages/protocol` schemas for published agent configuration, automation policies, credential metadata and device authorization, run admission/detail/activity/cancel/retry, paginated cursors, and structured errors
- [x] 2.3 Extend server status negotiation with supported agent-origin event versions and the minimum compatible client behavior
- [x] 2.4 Add protocol tests for strict payloads, request and response bounds, rejected embedded secrets, stable version fields, activity pagination, and authorization-safe identifiers

## 3. Local Executor and Credential Migration

- [x] 3.1 Add a forward local SQLite migration under `apps/desktop/src-tauri/migrations` for local runs, attempts, ordered activity, result identity, and interrupted-run recovery
- [x] 3.2 Extend the native event repository and `apps/desktop/src/persistence/eventStore.ts` with typed local run append, observe, cancel, retry, settle, and startup-interruption operations
- [x] 3.3 Move local ChatGPT OAuth and OpenAI API-key secrets from ordinary Tauri settings into `credential_vault`, retaining only credential references and sanitized metadata in Zustand settings
- [x] 3.4 Adapt the bundled Pi sidecar and current desktop tools to `packages/agent-runtime` interfaces while preserving web, outline-search, image-generation, declarative-public-GET, streaming activity, and abort behavior
- [x] 3.5 Implement `LocalAgentExecutor` and migrate local slash-command execution to durable run records, ephemeral previews, and one validated final outline commit
- [x] 3.6 Add migration, repository, credential, executor, restart, cancellation, required-tool, atomic-result, and existing manual-skill regression tests for local mode

## 4. Server Persistence and Queue

- [x] 4.1 Add a repeatable, forward-only `apps/server/migrations/0002_agent_executor.sql` for immutable configuration revisions, encrypted provider credentials, runs, attempts, append-only run events, leases, trigger identities, and unique results
- [x] 4.2 Update the server migration runner to apply numbered SQL migrations in deterministic filename order and test clean install plus upgrade from `0001_server.sql`
- [x] 4.3 Extend in-memory and PostgreSQL repository contracts for configuration compare-and-swap, credential metadata, run admission, cursor activity, cancellation, retry links, claims, lease renewal, failure, and completion
- [x] 4.4 Implement `FOR UPDATE SKIP LOCKED` claiming, bounded leases, attempt accounting, expired-lease recovery, retry availability, cancellation checks, and terminal-state invariants
- [x] 4.5 Implement immutable admission snapshots containing source/context, target, base revision, resolved definitions, effective tools, configuration revision, and credential reference without secret material
- [x] 4.6 Add PostgreSQL concurrency tests for competing claims, expired leases, cancellation races, attempt exhaustion, activity sequence ordering, configuration revision conflicts, and unique result identities

## 5. Server Credential Providers and Authorization

- [x] 5.1 Add server configuration for a versioned credential-encryption master key, OAuth/device-auth deadlines, worker controls, provider endpoints, and secret-safe public logging
- [x] 5.2 Implement authenticated encryption for API keys, OAuth access/refresh tokens, transcript keys, and image-provider keys with nonce, key-version, corruption, and redaction tests
- [x] 5.3 Implement server-side ChatGPT device authorization start/poll/complete, account-ID extraction, row-locked refresh-token rotation, authentication-required state, and explicit disconnect
- [x] 5.4 Implement the server OpenAI API-key credential provider and a shared `ModelCredentialProvider` resolver that returns runtime credentials only in memory
- [x] 5.5 Extend bootstrap and token authorization with `agents:read`, `agents:execute`, and `agents:manage` scopes while retaining `notes:create` isolation and outline binding
- [x] 5.6 Add Fastify credential enrollment, sanitized metadata, status, and disconnect endpoints plus tests for each scope, cross-outline hiding, revoked refresh, concurrent refresh, and absence of secrets in responses/logs

## 6. Source Inspection and Server-Safe Tools

- [x] 6.1 Implement canonical public URL inspection with known YouTube/X identities, credential rejection, fragment handling, redirect bounds, DNS resolution, and private/special-use address blocking
- [x] 6.2 Port web search and bounded webpage reading behind injected server fetch adapters, retaining Jina/reader disclosure and SSRF protections
- [x] 6.3 Add an explicit X/Twitter status reader that validates known status URLs and returns bounded post-aware content and normalized provenance through the configured public reader
- [x] 6.4 Define `TranscriptProvider` and implement the initial Supadata adapter for immediate and asynchronous transcripts, language metadata, 100,000-character bounds, deadlines, cancellation, and secret redaction without scraping or audio download
- [x] 6.5 Add server adapters for outline search, structured note emission, and image generation/content-addressed asset storage so existing server-mode manual skills retain supported capabilities
- [x] 6.6 Build the server tool registry with explicit capability and origin allowlists; keep shell, filesystem, arbitrary authenticated HTTP, and unapproved declarative origins unavailable
- [x] 6.7 Add injected-HTTP tests for URL variants, DNS rebinding defenses, redirects, X/web reads, transcript success/polling/unavailable/rate-limit/timeout/cancel cases, image assets, truncation, prompt injection labelling, and secret-free errors

## 7. Server Runner and Worker Lifecycle

- [x] 7.1 Implement the headless server runtime adapter using the shared model/tool loop, snapshotted definitions, executor-owned credentials, bounded activity, and structured results
- [x] 7.2 Implement worker polling, configured concurrency, claim/lease renewal, graceful shutdown, transient failure classification, bounded backoff, attempt exhaustion, and startup recovery
- [x] 7.3 Implement durable cancellation signalling from lease renewal into active model and provider abort signals, including the final cancellation check under the run lock
- [x] 7.4 Implement transactional result materialization as parent-first `note.created` and asset-reference events with `agent` origin, contiguous revisions, one run change group, projection updates, terminal provenance, and a unique result row
- [x] 7.5 Handle moved live targets by stable ID and cancel `target_unavailable` runs without output or resurrection when targets are trashed or purged
- [x] 7.6 Start and stop the worker from `apps/server/src/main.ts` only when migrations, compatible event versions, credentials, and worker configuration are valid
- [x] 7.7 Add runner and worker tests for prompt/config snapshots, tool intersection, OAuth/API-key resolution, success, retry classes, cancellation, restart, lease loss, concurrent outline edits, target loss, ambiguous commit retries, and exactly-once output

## 8. Inbox Automation and Notes API Admission

- [x] 8.1 Implement versioned automation policy schemas with bounded equality, source-kind, URL-host/type predicates, priorities, enabled state, ordered skill IDs, and optional dispatcher configuration
- [x] 8.2 Implement deterministic rule matching and skill de-duplication using canonical capture metadata and URL inspection, with fixtures for YouTube, X/Twitter, webpages, mixed links, and malformed input
- [x] 8.3 Implement the bounded dispatcher classifier for explicitly ambiguous policies, restricting output to configured skill IDs and exposing no write-capable tools
- [x] 8.4 Extend in-memory `createNote` so only new canonical-Inbox API captures atomically admit matched run snapshots while non-Inbox, unmatched, disabled, and agent-origin notes admit none
- [x] 8.5 Extend PostgreSQL `createNote` with the same atomic note/projection/idempotency/run transaction and unique trigger identity, returning replayed Notes API responses before re-evaluating newer policies
- [x] 8.6 Add repository and endpoint tests for absent profiles, multiple/de-duplicated skills, policy edits after admission, stale publication, dispatcher validation, non-Inbox capture, idempotent API retry, recursion prevention, admission rollback, and later provider failure preserving the capture

## 9. Agent and Automation Server APIs

- [x] 9.1 Add device-authenticated compare-and-swap APIs for reading and publishing sanitized server agent, skill, tool, and automation-policy configuration revisions
- [x] 9.2 Add manual run invocation and idempotency APIs that snapshot stable source/target context and reject stale, missing, trashed, cross-outline, or unsupported configuration
- [x] 9.3 Add bounded run list/detail and cursor activity APIs with sanitized status, attempts, tool names/outcomes, result revisions, and retry linkage
- [x] 9.4 Add idempotent cancellation and linked user-retry endpoints with `agents:execute` authorization and current-configuration snapshotting
- [x] 9.5 Add Fastify tests for valid scope combinations, `notes:create` denial, cross-outline hiding, validation limits, stale revisions, pagination, cancellation races, retry links, and unchanged Notes API request/response behavior

## 10. Desktop Server-Mode Integration

- [x] 10.1 Add narrow Tauri server transport commands for configuration, credential enrollment/status/disconnect, run admission/list/activity/cancel/retry using the stored origin, instance ID, outline ID, and device credential
- [x] 10.2 Enforce the existing TLS, origin pinning, redirect, timeout, response-size, sanitized-error, and authentication-required behavior for every new native command
- [x] 10.3 Add typed desktop clients and a `ServerAgentExecutor` implementing the same invoke, observe, cancel, and retry interface as `LocalAgentExecutor`
- [x] 10.4 Route every manual skill through the executor selected by storage mode, remove direct server-mode model calls, and surface queued/server-unavailable/authentication-required/upgrade-required states without local fallback
- [x] 10.5 Replace editor-persisted token streaming with ephemeral activity preview and commit only synchronized/local terminal structured output, preserving selection and one coherent undo change group
- [x] 10.6 Add run history and activity UI with terminal status, sanitized errors, matched policy/skill, result navigation, cancellation, and linked retry
- [x] 10.7 Add Settings UI for local versus server definitions, explicit publish/revision conflicts, automation enablement and rule ordering, supported-tool checks, ChatGPT device login, API-key enrollment, credential status, and disconnect
- [x] 10.8 Add Rust, client, Zustand, component, slash-command, activity, selection, undo, disconnected-state, credential, policy, and source-routing tests for local and server modes

## 11. Compatibility, Documentation, and Verification

- [x] 11.1 Gate agent output on advertised event compatibility, update minimum-client handling, and test that unknown agent-origin events do not advance desktop acknowledgements
- [x] 11.2 Document server worker deployment, encryption-key backup/rotation, ChatGPT device authorization, API-key alternative, provider disclosures, transcript setup, credential revocation, scopes, retries, run retention, and failure recovery
- [x] 11.3 Update Apple Shortcuts capture documentation with canonical `source` properties and explain that the existing Notes API remains synchronous and backward compatible while eligible work continues in the background
- [x] 11.4 Document default disabled YouTube, X/Twitter, and webpage policies, their skills/tools/result placement, expected provider usage, and how local-only execution differs from unattended server processing
- [x] 11.5 Run shared package, desktop, server, protocol, domain, component, and workspace tests with `npm test` and `npm run test:workspace`, and resolve every failure
- [x] 11.6 Run PostgreSQL migration/integration tests from a clean database and from schema `0001`, including concurrency, restart, OAuth refresh, atomic Inbox admission, and exactly-once result scenarios using fake providers
- [x] 11.7 Run Rust tests, TypeScript typechecks, production builds, and strict OpenSpec validation; confirm no secrets or raw fetched bodies appear in fixtures, snapshots, logs, events, or API responses
- [ ] 11.8 With explicit owner approval and disposable credentials/data, perform a manual end-to-end smoke test for local manual execution, server manual execution, background YouTube transcription/summary, X research, cancellation, restart recovery, sync, and disconnect
- [x] 11.9 Map every requirement scenario in this change to automated test or documented manual evidence before marking the change complete
