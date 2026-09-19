# ADR-0021: Allow Explicitly Trusted Local Code Through a Forage Extension Contract

- **Status:** Accepted
- **Date:** 2026-09-19
- **Deciders:** Forage maintainers
- **Supersedes:** ADR-0007 only for explicitly trusted local extensions
- **Superseded by:** None

## Context

ADR-0007 deliberately rejected arbitrary JavaScript extensions when Forage was
a thin frontend with a narrow set of declarative network tools. Forage now has
a local Node.js sidecar, explicit tool policy, bounded run contracts, and a need
for integrations that cannot be expressed as unauthenticated GET templates.

Using the embedded Pi SDK's extension API directly would make an internal agent
engine part of Forage's public product contract. It would also inherit package,
terminal, session, and project-discovery behavior that Forage does not want.

Executable extensions cannot be made safe merely by describing their tools in
a manifest or running them in a child process. Once enabled, trusted Node.js
code can use the current user's filesystem, network, process, and environment
permissions. Tool authorization controls what the model can invoke; it does not
sandbox extension initialization or lifecycle hooks.

## Decision Drivers

- Support useful authenticated and stateful local integrations.
- Keep tool access visible, bounded, and deny-by-default.
- Avoid making Pi types, manifests, package conventions, or sessions public.
- Let users inspect an extension before any executable module is imported.
- Keep local installation and execution authority off the synchronized server.
- State the trusted-code boundary accurately instead of implying a sandbox.

## Considered Options

1. **Forage-native trusted local extensions** — versioned manifest and host API,
   adapted internally to the local agent engine.
2. **Pi-compatible extensions** — expose Pi's format and APIs directly.
3. **Declarative tools only** — retain ADR-0007 without an exception.
4. **Sandboxed third-party plugins** — create a capability-secure runtime before
   supporting extensions.

## Decision

We will **support explicitly installed, reviewed, and enabled local Node.js code
through a versioned Forage-native extension manifest and API** because **Forage
needs a practical local integration boundary whose identity, lifecycle, and
tool policy remain owned by the application**.

Every source has a stable installation identity and a `forage.extension.json`
manifest that can be inspected without importing its entry module. Manifest and
API versions are independent. Static tool and hook declarations must exactly
match runtime registration. Built-in tool IDs, including `emit_outline`, are
reserved. Duplicate providers fail closed rather than being selected by load
order.

Installation, source trust and enablement, extension configuration, global tool
authorization, and per-agent tool selection are distinct decisions. Installing
or enabling an extension never authorizes its tools. The model sees only the
intersection of executor support, global enablement, agent selection, and run
policy, plus application-owned structured output.

The extension entry receives a small Forage host API for registering tools and
`run:start`/`run:end` hooks. Tool results, progress, logs, configuration, and
cancellation use bounded Forage contracts. The API exposes no Pi, editor,
Tauri, React, server, terminal, or model-provider objects. Pi remains an
internal local execution adapter and can be replaced without changing the
extension format.

Extension inventory reads manifests only. Executable validation occurs only
after trust and without model credentials or extension secret values. A run
receives an immutable local extension snapshot recording source and
configuration revisions. This snapshot and all paths, trust decisions,
settings, and secrets remain device-local and are not part of portable agent
configuration.

This is a narrow exception to ADR-0007's rejection of arbitrary JavaScript.
ADR-0007 continues to govern built-in and declarative custom tools and all
server execution. Forage does not claim that the extension process boundary,
manifest, or tool toggles form a security sandbox.

## Consequences

### Positive

- Authors get a stable product-owned API instead of depending on an internal
  agent engine.
- Users can inspect identity and declared contributions before code execution.
- Tool IDs and provenance remain stable across configuration and run admission.
- Existing global, agent, skill, and run-policy checks continue to govern model
  invocation.
- Server authority and portable configuration remain independent of local code.

### Negative

- Enabled extensions execute with the user's local process permissions.
- Forage owns manifest/API compatibility, package lifecycle, diagnostics, and
  revision retention.
- A process boundary limits crashes and protocol corruption but does not prevent
  malicious local filesystem or network access.
- Hooks may execute even when every contributed model tool is disabled.

### Risks and Mitigations

- **A manifest understates executable behavior.**

  **Mitigation:** Present an explicit trusted-code warning before activation and
  never describe the format as a permission sandbox.
- **An extension replaces an application tool or another provider.**

  **Mitigation:** Reserve built-in IDs and fail every conflicting provider
  closed with deterministic diagnostics.
- **Local code or logs corrupt the host protocol or leak supplied secrets.**

  **Mitigation:** Give validation no model credentials or extension secrets,
  reserve stdout for validated bounded messages, redirect conventional logs,
  and sanitize known secrets. Do not claim protection against deliberately
  malicious code after trust.
- **A local revision changes between admission and execution.**

  **Mitigation:** Snapshot digests and ownership at admission, retain immutable
  managed revisions for active runs, and reject stale local snapshots.
- **Synchronized configuration causes local execution on the wrong authority.**

  **Mitigation:** Synchronize only portable tool references. Server-mode runs
  reject unsupported required tools and never fall back to a desktop extension.

## Option Analysis

### Forage-native trusted local extensions

This gives Forage control over compatibility, policy, app presentation, and
engine replacement. Its cost is maintaining a deliberately small public API and
an honest trusted-code lifecycle.

### Pi-compatible extensions

Direct compatibility would accelerate initial loading but would expose an
implementation dependency as the product API and import behavior designed for
Pi's terminal and session model.

### Declarative tools only

This preserves the narrowest boundary but cannot express authenticated,
stateful, or lifecycle-aware local integrations.

### Sandboxed third-party plugins

A capability-secure runtime could reduce trust but requires a substantially
different execution, packaging, and permission system. It is not the v1
extension model and may be considered separately.

## Implementation Notes

- `@forage/agent-runtime` initially owns host-neutral validation contracts.
- `@forage/extension-api` exposes the author-facing subset and
  `defineExtension` without application or engine dependencies.
- The local host adapts admitted tools and hooks to the pinned agent SDK behind
  the Forage boundary.
- Extension inventory, configuration, secrets, package data, and run snapshots
  stay under device-local ownership.
- Normal startup, refresh, and invocation do not download or update packages.

## Validation

- Invalid, traversal-bearing, oversized, Pi-only, or incompatible manifests are
  rejected without importing their entries.
- Reserved, custom HTTP, duplicate extension, and duplicate provider identities
  fail closed deterministically.
- Installing or enabling a source does not authorize any contributed tool.
- Local snapshots cannot enter portable configuration or server run inputs.
- Public extension contracts have no Pi, desktop, Tauri, React, or server types.
- Server runs do not load or fall back to local extensions.

## References

- [ADR-0007: Expose Only Bounded Declarative Network Tools to the Model](ADR-0007-bounded-declarative-model-tools.md)
- [ADR-0013: Embed the Pi SDK in a Local Node.js Sidecar](ADR-0013-embedded-pi-sdk-sidecar.md)
- [Forage architecture](../architecture.md)
- [Forage extensions change](../../openspec/changes/add-forage-extensions/design.md)
