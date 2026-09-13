# ADR-0017: Provision and Mirror Server-Authoritative Agent Configuration

- **Status:** Accepted
- **Date:** 2026-09-13
- **Deciders:** Forage maintainers
- **Supersedes:** None
- **Superseded by:** None

## Context

Forage needs portable agents, skills, custom tools, and tool policy in both
local and server execution modes. The initial server integration stores
versioned configuration in PostgreSQL but also retains editable desktop
settings.

Older connections may contain only an outline. Current compatibility code
therefore publishes missing configuration when Compute settings open or when a
user first invokes an agent. This makes Run a hidden repair workflow and leaves
the desktop and server acting like two silent configuration authorities.

The desktop must retain configuration after disconnection so the user can
continue local work. That requirement does not require two authorities while a
server connection is active; it requires an explicit authoritative copy and a
versioned local mirror.

## Decision Drivers

- First connection must copy the user's portable configuration as well as the
  outline.
- Pressing Run must not migrate or publish configuration.
- Connected Settings changes must have deterministic conflict behavior.
- Deliberate disconnection must leave a complete usable local configuration.
- Outline synchronization, configuration, compute, and worker availability can
  become ready independently.
- Interrupted provisioning must be safe to retry.

## Considered Options

1. **Server authority with a versioned local mirror.** Provision explicitly,
   write through while connected, and reconcile on reconnect.
2. **Desktop authority.** Republish the desktop configuration whenever the
   server differs or before each run.
3. **Independent local and server configuration.** Require users to maintain
   both manually with no synchronization relationship.

## Decision

We will **make portable agent configuration server-authoritative while
connected and retain a versioned, complete local mirror** because **this gives
server execution one configuration authority without sacrificing local use
after disconnection**.

The portable configuration contains agents, skills, custom tools, and tool
policy. Model choice and credential binding are governed separately by
ADR-0018.

First connection is an explicit idempotent provisioning workflow:

1. pin and validate the server;
2. claim/seed or adopt the outline;
3. synchronize the canonical outline;
4. import or reconcile portable configuration;
5. persist the confirmed local mirror; and
6. offer separate compute setup.

Each step is recorded and retryable. Normal Run performs none of these steps.

While connected, Settings publishes with compare-and-swap and updates the
local mirror only from the confirmed server response. The mirror stores the
portable configuration, last server revision, and canonical configuration
hash.

After deliberate disconnection, the mirror becomes the active local
configuration and may be edited. Reconnection compares both sides with their
recorded base:

- only server changed: pull server;
- only local changed: publish local with compare-and-swap;
- neither changed: do nothing; and
- both changed: show a whole-configuration conflict with **Use local** and
  **Use server** choices.

Forage will expose readiness as independent capability state rather than one
boolean. A server may be ready for outline synchronization while configuration,
compute, the worker, or the disposable note index needs attention. Outline
synchronization readiness is sufficient for editing; agent execution has
additional prerequisites.

## Consequences

### Positive

- Connected execution and automation use one published configuration.
- Disconnection retains a complete and editable local fallback.
- Configuration conflicts are visible instead of becoming last-writer-wins
  loss.
- Connection failures identify the incomplete provisioning capability.
- Agent invocation becomes free of hidden configuration writes.

### Negative

- SQLite must persist server configuration revision/hash metadata.
- Reconnect needs a configuration reconciliation state machine and conflict UI.
- Users may occasionally choose between two whole configurations.
- Readiness UI and protocol become more detailed than a single connected flag.

### Risks and Mitigations

- **A stale desktop overwrites newer server configuration.**

  **Mitigation:** Require compare-and-swap against the stored server revision.
- **The local mirror updates after a failed publication.**

  **Mitigation:** Write through to the server first and persist only its
  confirmed response.
- **Provisioning interruption leaves a partial connection.**

  **Mitigation:** Persist idempotent step completion and resume at the first
  incomplete step.
- **A configuration conflict blocks outline editing.**

  **Mitigation:** Gate only agent configuration/execution; keep outline sync and
  editing available.

## Option Analysis

### Server authority with a versioned local mirror

This satisfies both connected consistency and disconnected availability. Its
cost is explicit synchronization metadata and a conflict path.

### Desktop authority

This appears simple for one device but breaks server automation, surprises
other devices, and makes every invocation a potential configuration mutation.

### Independent configurations

This avoids merge logic but requires duplicate administration and makes it
unclear which configuration should be restored on disconnect.

## Implementation Notes

Configuration synchronization has its own lifecycle and does not ride on every
outline sync. Existing lazy publication remains only as a versioned rollout
bridge and is removed after provisioning and compatible clients ship.

Readiness responses should include relevant revisions, compatibility state,
sanitized missing requirements, and recovery actions. A missing compute
credential does not make the outline connection unavailable.

## Validation

- Provisioning resumes correctly after failure at every step.
- Connected Settings uses compare-and-swap and mirrors only confirmed state.
- Tests cover all four reconnect outcomes and concurrent publication races.
- An outline-only legacy connection imports configuration without requiring an
  agent invocation.
- Pressing Run emits no configuration publication request.
- Sync-ready/compute-not-ready mode remains editable and synchronized.

## References

- [ADR-0012: Use an Event Store with an Optional Self-Hosted Server](ADR-0012-event-store-and-optional-server.md)
- [ADR-0015: Seed the Server Outline From the First Desktop](ADR-0015-blank-server-outline-adoption.md)
- [ADR-0018: Resolve Models and Credentials Through Environment Compute Profiles](ADR-0018-environment-compute-profiles.md)
- [Approved design specification](../superpowers/specs/2026-09-13-server-mode-authority-and-agent-execution-design.md)
- [Implementation plan](../superpowers/plans/2026-09-13-server-mode-authority-and-agent-execution.md)
