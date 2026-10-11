# ADR-0024: Own Local MCP OAuth Authorization and Rotation Outside Agent Runs

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** Forage maintainers
- **Extends:** ADR-0014 and ADR-0023

## Context

OAuth-only HTTP MCP servers need browser consent without requiring users to paste tokens. Ordinary MCP discovery has short deadlines, and independent agent sessions cannot safely own refresh rotation. The pinned SDK's full OAuth transport can replay a request after unauthorized responses; an external mutation may already have occurred.

## Decision

Keep interactive authorization in a dedicated, cancellable Node worker launched only by explicit Settings actions. Use SDK protected-resource/OAuth/OIDC metadata validation, public-client registration, Authorization Code and PKCE S256. Support advertised dynamic registration or one explicitly supplied public client ID/metadata URL; reject confidential-client setup, unsupported grants, and borrowed identities. Bind an ephemeral listener to `127.0.0.1` with the exact registered `/oauth/callback` URL, fresh state, required issuer validation, one-shot consumption and a five-minute total deadline. Constrain destinations, DNS, redirects, sizes and timeouts; never forward configured MCP headers to metadata or authorization services.

The application broker owns private worker IPC and native SQLite leases. Separate scoped OAuth records store resource, issuer, registration, tokens and expiry. Generation/version checks reject cancelled, replaced, disconnected, or stale commits; tokens and sensitive connection configuration commit transactionally. New metadata persistence failure invalidates authorization. Refresh starts with a durable pending marker, is serialized per connection, and releases access only after rotated credentials are saved. A failed or ambiguous exchange is not automatically repeated. Omitted replacement refresh tokens are retained. Native narrow operations do not expand the general credential API's reference allowlist.

OAuth consent never enables tools. New connections start ungranted; every interactive reauthentication pauses saved grants for explicit review, even with unchanged definitions. An opaque review revision prevents an admitted run from using a newly signed-in account. Silent refresh retains tool IDs and policy. Read-only selections remain visible while sign-in is required.

Runtime sessions use a noninteractive, access-token-only provider, no unauthorized hook, insufficient-scope throw, and no external-call/turn replay. Credential requests are admitted by connection and endpoint and consumed before activity routing. Refresh credentials, verifier/code, authorization URLs and token responses are absent from model messages, activity, diagnostics and portable settings. Active authorization URLs are ephemeral recovery UI only. Native disconnect invalidates local ownership before bounded best-effort remote revocation.

## Consequences

- OAuth support remains generic and device-local; backend connections and other clients' credential caches are unchanged.
- The existing SQLite vault is not an OS keychain and introduces no encryption-at-rest guarantee.
- Some providers cannot register this public native client or permit its exact loopback callback. Unsupported setup is reported honestly rather than weakening validation.
- Interrupted/ambiguous refresh may require explicit browser recovery. This sacrifices automatic recovery to avoid repeated exchange or external mutation.
- Native/browser, clipboard, account-switch and live Atlassian acceptance checks require the user; automated fixtures do not establish provider interoperability.

## Validation

Protocol fixtures, source/bundled worker tests, native stale-write/rotation tests, private IPC and Settings/store permission tests are recorded in [verification](../../openspec/changes/add-local-mcp-oauth/verification.md). No browser or Computer Use automation is used.

## References

- [MCP setup](../mcp.md)
- [OpenSpec design](../../openspec/changes/add-local-mcp-oauth/design.md)
- [ADR-0023](ADR-0023-environment-owned-mcp-clients.md)
