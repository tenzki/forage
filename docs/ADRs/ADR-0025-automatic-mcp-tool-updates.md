# ADR-0025: Preserve MCP Approvals Across Tool Definition Updates

- **Status:** Accepted
- **Date:** 2026-09-30
- **Supersedes:** ADR-0023's definition-bound identities and repeated authorization after definition changes

## Context

Requiring users to refresh and reapprove tools whenever a server changes a description or input schema interrupts ordinary workflows. The user explicitly prefers trusting updates to already-approved tools.

## Decision

Generate permission IDs from environment, connection identity, exact remote name, and command/endpoint binding, not the mutable definition. Keep a separate definition fingerprint for metadata and a binding fingerprint for execution checks. Local refresh retains existing IDs by remote name within the same binding, including legacy IDs, so saved global and agent selections do not need rewriting.

At run start, discover and validate current definitions, expose only admitted remote names under their saved permission IDs, and use current descriptions and schemas. Missing tools and changed bindings still fail closed. Legacy snapshots validate the stored definition fingerprint against the resolved binding; redacted legacy metadata that cannot establish that binding requires inventory refresh.

Definition-only changes do not invalidate open permission selection. Tool-list, binding, availability, and account-review revision changes still do. New tools are never enabled or assigned automatically. Removed tools are disabled on refresh. Explicit initial selection, OAuth account-change review, credential refresh, bounded execution, secret redaction, and no automatic external-action replay remain unchanged.

## Consequences

Approval trusts future changes to an existing tool, including semantic changes; schema validation does not prove unchanged behavior. Backend upgrades from definition-hashed IDs require one initial selection of the new stable IDs; later restarts and definition updates retain them. Local legacy approvals survive refresh without another selection.

See [MCP setup](../mcp.md).
