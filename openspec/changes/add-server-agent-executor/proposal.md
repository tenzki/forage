## Why

Forage can receive links and notes through its external Notes API, but agent work still runs interactively inside the desktop process. As a result, captured Inbox items cannot be classified or enriched while the app is closed, and server mode would otherwise require a second, divergent implementation of agents, skills, tools, and credentials.

## What Changes

- Extract the current desktop agent harness into a shared execution contract that can run inside the desktop in local mode or in a durable server worker in server mode.
- Route all agent execution through the server while an outline is in server mode, including manual skill invocations and automatic Inbox processing; local mode retains local execution through the same contracts.
- Add durable agent runs with stable identities, queued/running/terminal states, bounded retries, cancellation, idempotent tool calls and outline writes, interruption recovery, and user-visible activity and errors.
- Add configurable Inbox automation policies. Policies can match capture provenance and deterministic content facts such as URL host/type, then select a skill directly or invoke a dispatcher agent for ambiguous classification.
- Add source-aware tools for normalized URL inspection, existing X/Twitter reading, and YouTube transcript retrieval. Skills use those tools to research and document webpages or posts, and to transcribe and summarize videos.
- Preserve every captured Inbox item as the source record and write agent results as ordinary outline content beneath or adjacent to it, with run, skill, tool, URL, and source provenance. Automation never silently replaces or deletes the capture.
- Store agent, skill, tool, and automation-policy configuration with the authoritative outline in server mode so desktop and background workers resolve the same versioned definitions and capability allowlists.
- Let a trusted local or self-hosted server authenticate model execution with either ChatGPT-managed Codex device OAuth or an OpenAI API key. The executor owns refresh and revocation handling, secrets are encrypted at rest, and jobs reference credential IDs rather than containing access or refresh tokens.
- Keep the existing `POST /api/v1/notes` request and response contract compatible. An eligible, successfully committed Inbox capture atomically admits at most one automation trigger, while note creation remains successful even when the later agent run fails.
- Treat captured pages, posts, and transcripts as untrusted input; source tools remain allowlisted and bounded, reject private-network targets, keep credentials out of model context, and expose no general shell or arbitrary authenticated HTTP access.

## Capabilities

### New Capabilities

- `agent-execution`: Shared local/server agent runtime, durable run lifecycle, execution placement, configuration resolution, credential providers, tool authorization, cancellation, retries, and observability.
- `inbox-automation`: Policy matching, optional agent classification, trigger idempotency, skill dispatch, source preservation, result placement, and user controls for automatic Inbox processing.
- `source-content-tools`: Safe source-type detection and bounded content acquisition for webpages, X/Twitter links, and YouTube transcripts, including normalized provenance and failure behavior.

### Modified Capabilities

- `notes-api`: Eligible Inbox captures atomically admit an idempotent automation trigger without changing the existing create-note payload, synchronous response, or retry semantics.
- `server-synchronized-outlines`: The authoritative server commits server-originated agent output events and terminal run provenance under the same ordered event and projection guarantees as user and API changes.

## Impact

- `apps/desktop/src/agent`, its Pi sidecar, and agent settings become clients/adapters of shared runtime and protocol packages instead of the only execution environment.
- `apps/server` gains worker admission, leasing/recovery, run persistence, model credential enrollment and refresh, source-tool adapters, and APIs for invoking, observing, cancelling, retrying, and configuring agent work.
- `packages/domain`, `packages/protocol`, and the PostgreSQL schema gain versioned agent definitions, skills, automation policies, run/tool-call records, credential references, and server-originated outline event contracts.
- Server-mode settings must clearly distinguish Forage device/API tokens from model-provider credentials. ChatGPT OAuth refresh tokens, OpenAI API keys, transcript-provider keys, and similar secrets require encrypted server-side storage and explicit disconnect/revocation flows.
- The current Notes API stays backward compatible for external applications, but committing an eligible Inbox capture also creates durable automation work in the same transaction.
- Deployments that want processing while the desktop is closed must run the Forage server worker and configure outbound access to model and source providers. Local-only deployments continue to support interactive agent execution but cannot promise unattended background work.
- The active `add-inbox-and-daily-notes` change remains responsible for canonical Inbox identity and navigation; this change consumes that identity and adds automation without changing the Inbox's ordinary editable-content semantics.
