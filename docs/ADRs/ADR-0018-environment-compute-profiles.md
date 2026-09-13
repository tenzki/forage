# ADR-0018: Resolve Models and Credentials Through Environment Compute Profiles

- **Status:** Accepted
- **Date:** 2026-09-13
- **Deciders:** Forage maintainers
- **Supersedes:** None
- **Superseded by:** None

## Context

Current agent definitions may contain a model selection, and published server
definitions may contain a server credential reference. This couples portable
agent behavior to one execution environment and causes configuration rewrites
when a user merely changes the selected model or connects a different
credential.

Local and server execution have different credential stores and trust
boundaries. Local secrets live behind the Tauri/SQLite boundary under ADR-0014.
Server secrets live encrypted in PostgreSQL under an operator-supplied key.
Copying either credential identifier into a portable agent definition does not
make it meaningful in the other environment.

The product decision is that agents should lazily receive whichever model is
currently selected. Per-agent model choice is not needed initially.

## Decision Drivers

- Agent and skill definitions should be portable between local and server
  execution.
- Changing the selected model should not rewrite every agent.
- Credential identifiers and secret lifecycle are environment-specific.
- Server credentials must never be uploaded unexpectedly during a run.
- Historical runs must record which model and credential metadata they used.
- Skills still need a way to declare required capabilities.

## Considered Options

1. **One active compute profile per execution environment.** Agents remain
   model-agnostic; admission resolves model and credential lazily.
2. **Model and credential on every agent.** Keep the current explicit binding
   inside portable definitions.
3. **Client-selected compute on every server invocation.** Let the desktop send
   model and credential choices to the server with each run.

## Decision

We will **remove model and credential identity from portable agent definitions
and resolve one active compute profile per execution environment at
admission** because **model choice and credential binding describe where a run
executes, not what an agent is**.

A compute profile contains:

```text
provider
selectedModelId
credentialBinding
```

The local executor owns a local compute profile and resolves a local
credential. The server owns a server compute profile and resolves an encrypted
server credential. While connected, Compute settings edit the server profile.
After disconnection, local execution uses the independently retained local
profile.

Agents define instructions and allowed tools. Skills define workflow
instructions, their assigned agent, and capability requirements. Admission
checks those requirements against the selected model and executor capabilities.

The resolved model, provider, compute-profile revision, and sanitized credential
metadata are stored in the immutable run snapshot. Secret values are resolved
only inside the executor and never stored in configuration, request payloads,
run history, activity, or model context.

Credential setup is explicit. During provisioning the user may copy the current
credential, connect another credential directly on the server, or skip server
compute. Pressing Run never transfers a credential. Revocation prevents queued
runs from starting and stops further provider calls where safely possible.

## Consequences

### Positive

- Agents and skills move between local and server environments without embedded
  credential IDs.
- One model change affects subsequent runs without configuration churn.
- Credential trust and lifecycle remain explicit at each environment boundary.
- Historical runs remain reproducible and auditable from sanitized snapshots.
- The first UI can offer one simple global model selection.

### Negative

- Existing agent definitions and server configurations require an upcaster.
- Local and server compute profile storage and settings paths must be distinct.
- A user expecting per-agent models cannot configure them in the first release.
- Capability validation moves from publication time to admission time where the
  selected compute profile is known.

### Risks and Mitigations

- **A model change mutates an already admitted run.**

  **Mitigation:** Snapshot the resolved compute profile during admission; edits
  affect only later runs.
- **Credential metadata leaks through history or errors.**

  **Mitigation:** Define sanitized response schemas and test logs, snapshots,
  events, and activity for secret absence.
- **A skill requires a capability the selected model lacks.**

  **Mitigation:** Express the requirement on the skill and return a typed
  capability error before provider execution.
- **Copying a credential changes a trust boundary without consent.**

  **Mitigation:** Require an explicit provisioning action and never copy on Run.

## Option Analysis

### Environment compute profiles

This matches model/credential ownership to the executor, keeps definitions
portable, and minimizes settings churn. It intentionally gives all agents the
same selected model initially.

### Model and credential on every agent

This permits per-agent customization but duplicates environment bindings,
creates noisy configuration revisions, and makes local/server portability
fragile.

### Client-selected compute per invocation

This keeps desktop control but weakens server authority, complicates automation,
and lets stale clients influence server execution policy.

## Implementation Notes

The shared contracts need versioned upcasters that extract existing `modelId`
and `credentialRef` values into local or server compute profiles. Migrations
must not decrypt and reserialize server secrets; only references and sanitized
metadata move.

Per-agent overrides may be reconsidered later as an explicit layer over the
environment default. They are not silently preserved as hidden fields.

## Validation

- Agent definitions remain unchanged when selected model or credential changes.
- Local and server profiles can use different credentials for the same portable
  configuration.
- Runs admitted before and after a model change retain their respective
  snapshotted models.
- Credential revocation blocks queued work without exposing secret material.
- Configuration, protocol, persistence, activity, and logs pass secret-redaction
  tests.

## References

- [ADR-0013: Embed the Pi SDK in a Local Node.js Sidecar](ADR-0013-embedded-pi-sdk-sidecar.md)
- [ADR-0014: Store Local Credentials in the SQLite Event Store](ADR-0014-local-credentials-in-sqlite.md)
- [ADR-0017: Provision and Mirror Server-Authoritative Agent Configuration](ADR-0017-provision-and-mirror-server-agent-configuration.md)
- [Approved design specification](../superpowers/specs/2026-09-13-server-mode-authority-and-agent-execution-design.md)
- [Implementation plan](../superpowers/plans/2026-09-13-server-mode-authority-and-agent-execution.md)
