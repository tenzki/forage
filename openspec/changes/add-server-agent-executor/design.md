## Context

Forage currently has two relevant boundaries. The desktop owns agent definitions, skills, provider credentials, the Pi runtime, built-in and declarative tools, streaming activity, and insertion into the open ProseMirror editor. The optional server owns the authoritative PostgreSQL outline event order and exposes an idempotent Notes API that can receive plain text and bounded `source` properties while the desktop is closed.

That split prevents unattended processing: a server can accept a YouTube or X link but cannot use the user's configured skill to enrich it. Copying only the current access token into a job would not solve the problem because ChatGPT access tokens expire and their refresh lifecycle currently belongs to the desktop. Copying the whole desktop harness into the server would create two behaviorally different runtimes.

The initial deployment remains one owner with local-only and self-hosted server modes. Captured content and fetched pages are untrusted. PostgreSQL is available in server mode; Redis or a separate queue service is not. The current polling sync protocol, immutable outline events, canonical Inbox identity, and backward-compatible `POST /api/v1/notes` contract must remain intact.

## Goals / Non-Goals

**Goals:**

- Use one portable agent runtime and versioned configuration model for local and server execution.
- Execute every manual and automatic agent run on the authoritative server in server mode.
- Admit, resume, cancel, retry, observe, and settle runs durably without duplicate outline output.
- Trigger configured skills from eligible Inbox captures without changing the capture API.
- Support safe webpage/X reading and replaceable YouTube transcript retrieval.
- Support ChatGPT-managed Codex OAuth and OpenAI API keys without placing secrets in jobs, prompts, events, or logs.
- Commit final results through normal outline events so local caches, synchronization, undo boundaries, search, links, and provenance continue to see one document model.

**Non-Goals:**

- Multi-user credential sharing, team automation, invitations, or per-user run quotas.
- General cron scheduling, arbitrary event workflows, recurring agents, or autonomous processing outside explicit manual runs and configured Inbox captures.
- A shell, unrestricted filesystem access, unrestricted network access, browser automation, audio downloading, or server-side execution of arbitrary user code.
- Uploading desktop OAuth files or refresh tokens to the server automatically.
- Guaranteeing unattended execution in local-only mode after the desktop exits.
- Replacing the Notes API with a link-specific endpoint or making capture wait for enrichment.
- Selecting a production transcript vendor forever; the initial adapter is replaceable.

## Decisions

### 1. Introduce a portable runtime with environment adapters

Create `packages/agent-runtime` for runtime-validated agent, skill, tool, run-input, structured-output, and activity-event contracts plus the bounded model/tool loop. It has no React, Tauri, Fastify, PostgreSQL, keyring, or browser dependency. Network access, model calls, credentials, outline search, assets, clocks, IDs, and activity persistence enter through interfaces.

The existing desktop Pi sidecar becomes a local adapter of this package. The server imports the same runtime and supplies server adapters. `packages/protocol` exposes wire schemas without importing server or desktop implementation code. This was chosen over maintaining separate desktop and server harnesses because prompt composition, tool authorization, output validation, cancellation, and limits must be identical. Running every local call through the remote server was rejected because local mode must remain usable without a server.

An effective tool set is the intersection of the agent allowlist, skill requirements, globally enabled tools, execution-environment support, and run-policy allowlist. A run is rejected before model invocation when a required tool is unavailable. The initial server registry supports web search/read, X reading, YouTube transcripts, outline search, structured note emission, and image generation when its provider and asset storage are configured. Declarative public GET tools are server-disabled unless their origins are explicitly allowlisted; authenticated arbitrary HTTP, shell, and filesystem tools are never accepted.

### 2. Make execution placement follow storage authority

Local storage mode executes manual skills through an embedded `LocalAgentExecutor`, persists run/activity records in local SQLite, and marks unfinished runs `interrupted` on restart. It cannot promise progress while the app is closed.

Server storage mode sends manual run commands to the configured pinned server. The desktop does not fall back to local execution when the server is unavailable because doing so would split configuration, credentials, and output authority. Automatic Inbox runs exist only in server mode. Both executors implement the same invoke, observe, cancel, and retry contract.

Manual admission snapshots the source node ID, branch context, prompt, selected agent/skill/config versions, target placement, and base outline revision. Automation admission snapshots the immutable capture text and provenance plus the resolved definitions. Final output is based on that snapshot even if configuration later changes.

### 3. Separate authoritative configuration from secrets

In local mode, versioned agent, skill, tool, and enabled-tool configuration remains local and migrates from the existing Tauri settings. In server mode, PostgreSQL stores immutable configuration revisions per outline; the desktop edits a draft and publishes it with compare-and-swap on `baseRevision`. Runs pin a published revision and resolved definition snapshots so editing or deleting a skill cannot mutate queued work.

Automation policies are ordered declarative data. Each enabled policy contains bounded equality/host/source-kind predicates, an ordered list of skill IDs, and an optional dispatcher mode. Policies and definition snapshots contain credential references but never secret values. A missing definition, unsupported required tool, or revoked credential prevents publication or admission with a structured error.

Configuration is kept outside the outline event stream because it is operational control data, not user note content, and should not enter ProseMirror replay or undo. Device-authenticated APIs expose current revision and sanitized metadata. External `notes:create` tokens cannot read or mutate it.

### 4. Persist runs and use PostgreSQL as the server queue

Add `agent_runs`, `agent_run_attempts`, `agent_run_events`, and `agent_run_results`. A run has a stable ID, outline/owner binding, trigger and idempotency identity, source/target note IDs, immutable input/definition snapshots, a credential reference, status, attempt count, availability time, lease owner/expiry, cancellation timestamp, sanitized error code, and timestamps. Statuses are `queued`, `running`, `retry_wait`, `completed`, `failed`, `cancelled`, and `interrupted`; every admitted run eventually reaches a terminal state unless the worker remains unavailable.

Workers claim due runs with `FOR UPDATE SKIP LOCKED`, a bounded lease, and configured concurrency. Lease renewal proves ownership during long model or transcript calls. An expired lease is retried with bounded exponential delays when attempts remain; otherwise the run fails. Startup recovery makes abandoned work claimable. PostgreSQL was chosen over Redis so admission can share the Notes API transaction and the self-hosted deployment gains no new required service.

`agent_run_events` is an append-only, per-run sequence for state, model, tool, progress, and bounded preview events. It does not consume outline revisions. Clients poll after a sequence cursor initially; this matches the existing server architecture and can later be supplemented by SSE without changing the persisted contract. Prompt text, fetched bodies, reasoning, credentials, and raw provider errors are excluded from ordinary telemetry.

### 5. Admit Inbox automation in the note transaction

`POST /api/v1/notes` continues to validate, authorize, create one `note.created` event, update projections, store its idempotency response, and return without waiting for a model. If and only if the resolved parent is the current canonical Inbox and an enabled published policy matches, the same transaction also inserts deduplicated queued runs.

An identical Notes API retry returns the stored response before policy evaluation and cannot enqueue work from a newer configuration revision. Runs are unique by trigger identity, policy revision, and skill ID. Server-generated agent results and notes explicitly targeted outside Inbox never trigger automation, which prevents recursion.

Source classification first uses deterministic facts: valid canonical HTTP(S) URL, normalized host, source metadata, and known YouTube/X host and path forms. Matching policies run in priority order; repeated skill IDs are de-duplicated while preserving order. A policy may invoke multiple skills. An optional dispatcher agent is used only when its policy explicitly permits ambiguous or mixed content; its output is a bounded list of configured skill IDs and cannot invent tools or definitions. This keeps ordinary URL routing predictable while allowing classification beyond host matching.

Automation is opt-in and disabled until a valid profile, credential, and enabled policy are published. Failure of later enrichment never rolls back the accepted capture.

### 6. Commit structured output once through the outline event store

The runtime terminates with a validated structured result rather than writing the outline from a model-facing tool. Text output is bounded by node count, depth, per-node size, and total size; image references must identify completed owner-accessible assets. Fetched source references and run/skill provenance are retained separately from visible text.

Completion locks the run and outline, verifies lease/cancellation/target state, and checks that no result exists. It then creates parent-first `note.created` and asset-reference events beneath the stable target, assigns contiguous outline revisions, updates projections, inserts one `agent_run_results` record, appends a terminal run event, and marks the run completed in one transaction. Events use `origin: agent`, an executor device identity, one run change-group ID, and bounded source metadata containing run, skill, and source URL identifiers.

If the target was trashed or purged, completion does not resurrect it; the run is cancelled with `target_unavailable` and no outline result. A lease loss or transaction retry cannot create a second result because the result row and event IDs are deterministic and uniquely constrained. Streaming previews remain activity data until terminal commit, so a crash cannot leave unexplained partial bullets.

### 7. Treat cancellation and retry as durable commands

Cancellation records `cancel_requested_at` idempotently. A queued run becomes cancelled immediately; a running worker observes cancellation through lease renewal and aborts model/tool requests. Completion rechecks cancellation while holding the run lock, so a late result cannot win after accepted cancellation.

Automatic retry applies only to sanitized transient classes such as timeouts, rate limits, dependency unavailability, and selected 5xx responses. Invalid input, unsupported tools, authentication-required, permission failures, unavailable/private URLs, malformed model output, and target loss are terminal. A user retry creates a new run linked to the failed/cancelled run and the currently selected published configuration; it never mutates the historical run.

### 8. Make model credentials executor-owned

Define a `ModelCredentialProvider` that resolves a credential reference to either `{ provider: openai-codex, accessToken, accountId, expiresAt }` or `{ provider: openai, apiKey }`. Jobs carry only the reference.

For ChatGPT-managed Codex authentication, the active executor performs the device authorization flow. A local executor stores access/refresh/expiry/account ID in OS-backed credential storage. A server exposes device-token-authenticated start/status/disconnect endpoints or an equivalent administrator CLI; the user completes authorization in a browser, and the server stores the resulting encrypted credential. Refresh happens server-side under a row lock so refresh-token rotation cannot race. `invalid_grant` marks the credential authentication-required and blocks new runs until reconnection.

Server secrets are encrypted with an authenticated cipher and a versioned master key supplied outside PostgreSQL by the deployment's secret manager or environment. API keys, OAuth refresh tokens, transcript keys, and image-provider keys are never returned after enrollment, logged, placed in configuration snapshots, or exposed to tools/model context. Disconnect revokes the local reference and makes queued work fail safely. Copying desktop `auth.json` or automatically uploading desktop credentials was rejected because it hides a major trust-boundary change.

### 9. Implement source tools behind replaceable provider ports

URL inspection accepts only credential-free HTTP(S), canonicalizes known host aliases, removes fragments for identity, preserves the original URL for display, rejects local/private/special-use targets including DNS resolutions, and limits redirects. Known YouTube video URL forms produce a video identity; known X/Twitter status URLs produce a post identity; all other public URLs remain webpages.

Web and X reading reuse the existing bounded public-reader approach behind an injected fetch interface. The X tool is explicit so skills can request post-aware metadata even when the initial provider delegates to the same reader. YouTube uses a `TranscriptProvider` port; the initial Supadata adapter supports immediate and asynchronous responses, cancellation, deadlines, language metadata, and a bounded 100,000-character transcript. The server does not scrape captions or download audio.

Tool results are labelled as untrusted source material, carry normalized URL/provenance, and are truncated before entering model context. Secrets and full provider errors are redacted. Provider-specific configuration and disclosure are documented, and tests inject HTTP implementations rather than making live calls.

### 10. Authenticate agent APIs separately from capture

Extend owner device credentials with `agents:read`, `agents:execute`, and `agents:manage` scopes. Run observation requires read; manual invocation/cancel/retry requires execute; publishing definitions/policies and enrolling model credentials requires manage. One-owner bootstrap grants these to the owner's device credential. `notes:create` credentials retain only capture access.

Agent endpoints are under `/api/v1/outlines/:outlineId/agent-*` and apply the same outline binding, origin pinning, HTTPS, redirect, request-size, and authorization-safe error behavior as synchronization. The server never accepts provider tokens in an invocation payload.

### 11. Preserve compatibility through explicit rollout

Adding `agent` to event origin and adding provenance fields requires domain/protocol version support on every synchronizing client before a worker emits results. The server status advertises the event versions and a minimum compatible client. Server-mode agent settings remain disabled until configuration and credential migrations succeed.

The existing local settings are migrated into the shared schema without automatically publishing secrets or definitions to a server. When a user enables server mode, the UI explicitly offers to publish selected definitions and policies, then separately enrolls server credentials.

## Risks / Trade-offs

- **[Risk] ChatGPT refresh-token storage increases the server compromise impact.** → Require explicit enrollment, authenticated encryption with an external master key, strict log redaction, scoped management APIs, disconnect, and API-key fallback.
- **[Risk] At-least-once worker execution can repeat paid model/tool calls.** → Lease and attempt records make repeats visible; deterministic call IDs and provider idempotency are used where supported, while the final outline transaction remains exactly once.
- **[Risk] Captured pages can contain prompt injection.** → Mark all fetched content untrusted, keep tool capabilities fixed outside the model, expose no general execution tool, and validate the only write-shaped result after the model loop.
- **[Risk] Long transcripts overflow model context or output limits.** → Bound transcript bytes, expose language/length metadata, instruct summary skills to consume only necessary content, and reject structured output beyond document limits.
- **[Risk] Server and local behavior drift through environment-specific tools.** → Share the loop, schemas, fixtures, and contract tests; reject required unavailable tools rather than silently changing behavior.
- **[Risk] Configuration edits race with queued work.** → Publish immutable revisions and snapshot resolved definitions at admission.
- **[Risk] Automatic work causes unexpected cost.** → Keep policies disabled by default, show the matched policy/skills before publishing, expose run history and cancellation, and document provider usage.
- **[Risk] Result insertion races with edits or trash.** → Target stable node IDs, lock the current projection at commit, append against the latest revision, and cancel without resurrection when the target is unavailable.
- **[Trade-off] Server mode cannot fall back to local execution during an outage.** → Preserve one execution authority and surface queued/server-unavailable status; users can deliberately switch storage mode instead of creating split-brain output.
- **[Trade-off] Polling delays activity updates.** → Use bounded cursor polling initially; the append-only run-event API permits later SSE without data-model changes.

## Migration Plan

1. Add shared configuration/runtime schemas and cross-adapter contract fixtures while keeping the existing desktop path active.
2. Add local SQLite run records and adapt local manual execution to the shared executor; migrate existing agent/skill settings without moving secrets.
3. Add forward-only PostgreSQL migrations for published configuration, encrypted provider credentials, runs, attempts, run events, leases, and results. Deploy with workers and automation disabled.
4. Add scoped agent APIs, server credential enrollment/refresh, and server-safe tool providers. Verify secret redaction and capability negotiation before enabling execution.
5. Add the server worker and manual run path, then update compatible desktop clients to route server-mode skills through it.
6. Add atomic Inbox admission and publish disabled default YouTube/X/web policies. Enable policies only after explicit user configuration.
7. Enable server-generated agent output after the minimum-client gate, then exercise restart, cancellation, retry, OAuth refresh, API-key, link-provider, and synchronization scenarios.

Rollback disables automation admission and workers first; queued/run history and credentials remain stored but unused. Manual server invocation is then disabled while local mode continues to work. Already accepted agent output remains ordinary immutable outline history and is never deleted by rollback. Database migrations are not destructively reversed; older servers must refuse schemas or event origins they do not understand.

## Open Questions

- What default retention period should apply to sanitized run activity after terminal completion while preserving the minimal provenance attached to outline results?
- Should a later release add SSE for lower-latency activity once polling behavior and operational load are measured?
- Should additional transcript providers be selectable per policy, or remain a deployment-wide adapter until multi-user support exists?
