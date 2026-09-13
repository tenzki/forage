# ADR-0019: Admit Server Agents From Invocation Intents

- **Status:** Accepted
- **Date:** 2026-09-13
- **Deciders:** Forage maintainers
- **Supersedes:** None
- **Superseded by:** None

## Context

The initial desktop server executor constructs a nearly complete `RunInput`
before requesting admission. It reads server configuration but still assembles
model, credential, agent, skill, effective tools, prompt, context, and revision
state on the client. The server then discards or reconstructs portions of that
input.

This duplicates resolution policy and creates ambiguity about which side owns
configuration, context, and capability decisions. It also makes missing source
state look like authorization failure and keys duplicate safety partly through
configuration revision.

Server mode already makes PostgreSQL authoritative for outline order and owns
the durable queue. Admission should be the point where a small user intent
becomes one immutable, fully resolved server run.

## Decision Drivers

- The server must resolve execution from canonical outline and configuration
  state.
- A desktop should express user intent without supplying server policy.
- Lost responses and network retries must not duplicate model work or results.
- Editing and Settings changes after admission must not mutate an existing run.
- Errors must distinguish authorization from recoverable state conflicts.
- The protocol must support compatible staged rollout.

## Considered Options

1. **Small invocation intent with server resolution.** The desktop sends stable
   source/skill identity and the server constructs the run snapshot.
2. **Full client-constructed run input.** Keep the existing contract and add
   more server validation.
3. **Agent request as an outline event.** Put execution intent directly into the
   outline event stream and admit work while reducing it.

## Decision

We will **admit manual server agents from a small invocation intent and resolve
the complete immutable run snapshot on the server** because **the authoritative
server is the only boundary that can consistently combine canonical document,
published configuration, compute, authorization, and worker capability state**.

The versioned manual intent contains:

```text
sourceNodeId
skillId
prompt
acknowledgedOutlineRevision
invocationId
```

The server derives the initial result target from the stable source node. It
authenticates the device, verifies the canonical outline has reached the
acknowledged revision, resolves the live source and ancestor context, loads the
latest portable configuration, lazily resolves the active compute profile,
validates required tools/capabilities, creates the immutable snapshot, and
durably admits the run.

The run snapshot records canonical source and ancestor IDs/text, outline
revision, agent and skill definitions, effective tools, resolved model,
sanitized credential metadata, and placement target. Later outline,
configuration, or compute edits do not mutate it.

`invocationId` is the idempotency identity independently of configuration
revision. The server stores a canonical intent hash:

- an identical retry returns the existing run;
- the same ID with different intent returns idempotency conflict; and
- an explicit **Run again** action creates a new invocation ID linked to the
  earlier run.

Authorization errors are reserved for genuine permission failures. Bound
desktop clients receive typed state conditions such as outline not synchronized,
source missing/changed, configuration not ready/conflicted, compute not ready,
capability unavailable, or worker unavailable, with retryability and recovery
metadata. Public and cross-owner requests may continue hiding resource
existence.

## Consequences

### Positive

- One server service owns all admission resolution and validation.
- Desktop/server state duplication in the invocation contract is removed.
- Run snapshots are deterministic and unaffected by later settings changes.
- Stable invocation identity prevents duplicate work after ambiguous network
  outcomes.
- The UI can offer precise recovery instead of parsing generic error text.

### Negative

- The admission protocol and desktop transport require a versioned migration.
- Server admission does more canonical/configuration/compute resolution work.
- Old clients need an explicit compatibility window or minimum-version gate.
- Typed errors enlarge the shared protocol surface.

### Risks and Mitigations

- **An old client continues sending full run snapshots.**

  **Mitigation:** Advertise admission protocol capability, ship client support
  first, then raise the minimum compatible version before removal.
- **Two concurrent retries admit duplicate work.**

  **Mitigation:** Enforce invocation uniqueness and request-hash comparison in
  the admission transaction.
- **Source edits race with admission.**

  **Mitigation:** Wait for the initiating edit's acknowledgement and resolve the
  source from the canonical document at admission.
- **Detailed errors leak another owner's resources.**

  **Mitigation:** Return precise state only after correct owner/outline binding;
  retain hidden-resource behavior otherwise.

## Option Analysis

### Invocation intent with server resolution

This gives one admission authority and the smallest client contract. It fits
manual and future server-native invocation paths.

### Full client-constructed run input

Additional checks would reduce some risk but preserve duplicate policy and
stale-state decisions on the desktop.

### Invocation as an outline event

This gives strong ordering with document changes but mixes execution-control
intent into the content event stream and complicates local/server behavior. The
acknowledged-revision precondition provides the needed ordering with a smaller
change.

## Implementation Notes

Run admission remains an idempotent API command and `agent_runs` remains its
durable record. The desktop must durably append and synchronize the initiating
bullet before sending intent, but it does not wait for unrelated agents or lock
future edits.

Configuration publication and credential transfer are removed from the Run
path only after ADR-0017 provisioning and ADR-0018 compute profiles are
available.

## Validation

- Lost-response and concurrent identical retries return one logical run.
- Reusing an invocation ID with changed data returns idempotency conflict.
- Configuration changes do not permit the same invocation to execute twice.
- Admission snapshots canonical context and the active compute profile exactly
  once.
- Every typed error has protocol, HTTP, recovery, and desktop presentation
  coverage.
- Cache divergence cannot produce `authorization_denied` for a valid canonical
  source.

## References

- [ADR-0016: Use the Canonical Outline for Correctness-Critical Server Operations](ADR-0016-canonical-outline-over-note-index.md)
- [ADR-0017: Provision and Mirror Server-Authoritative Agent Configuration](ADR-0017-provision-and-mirror-server-agent-configuration.md)
- [ADR-0018: Resolve Models and Credentials Through Environment Compute Profiles](ADR-0018-environment-compute-profiles.md)
- [Approved design specification](../superpowers/specs/2026-09-13-server-mode-authority-and-agent-execution-design.md)
- [Implementation plan](../superpowers/plans/2026-09-13-server-mode-authority-and-agent-execution.md)
