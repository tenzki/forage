## Why

Connecting services such as Jira currently requires users to create and paste credentials, or maintain a separately authenticated bridge. Native browser sign-in will let users authorize compatible MCP servers without manually managing tokens, while preserving Forage's device-local credential ownership and explicit tool permissions.

## What Changes

- Add generic OAuth authorization for desktop/local Streamable HTTP MCP connections, without a Jira preset, a provider catalog, or an external proxy requirement.
- Extend URL setup with Browser sign-in, Manual credentials, and None, keeping independent drafts and existing launch-command setup unchanged.
- Add explicit system-browser sign-in, waiting, cancellation, recovery, and reauthentication using the Pen designs derived from `i7FjPu`.
- Discover authorization metadata and supported public-client registration, validate callback state and issuer, and use Authorization Code with PKCE.
- Store authorization behind the existing native credential boundary, refresh tokens safely across concurrent runs, and expose only sanitized connection status to Settings.
- Keep OAuth consent separate from tool/agent review: connecting grants nothing, review starts unchecked, and only Save access applies explicit grants.
- Preserve saved permissions when sign-in is required, but block execution until authorization and admitted tool definitions are valid. Agent runs never open a browser or automatically replay an MCP call.
- Preserve existing manual header/token, no-auth, stdio, JSON import, and backend behavior. Do not import another client's OAuth credentials or upload desktop authorization to the backend.

## Capabilities

### New Capabilities

- `local-mcp-oauth`: Device-local MCP browser authorization, independent authentication drafts, secure credential lifecycle, explicit permission review, noninteractive runtime access, and recovery.

### Modified Capabilities

None. This change adds authentication alongside the MCP client and Settings contracts in `add-mcp-client` and `redesign-settings`; it does not widen tool authorization, change backend ownership, or modify an existing canonical capability.

## Impact

- Shared MCP contracts and `@forage/mcp-host`, using the installed official MCP client SDK's OAuth facilities with application-owned persistence and request policy.
- Native credential commands/storage, a dedicated cancellable OAuth management lifecycle, trusted sidecar IPC, local run admission, and MCP Settings setup/detail/status.
- Depends on the implemented MCP and Settings foundations. It does not implement onboarding or edit the independent `add-desktop-onboarding` proposal.
- Adds fixture-based protocol, callback, storage/rotation, IPC, UI, permission, and runtime-no-replay coverage; updates MCP setup/architecture documentation during implementation.
- Requires user-performed native/browser verification against the Pen states and Atlassian's hosted endpoint before claiming live Jira compatibility. Provider registration and administrator policies can limit interoperability.

## Non-Goals

Backend OAuth, a hosted Forage authorization service, embedded login pages, client impersonation, device-code or machine-to-machine grants, MCP marketplaces, automatic tool invocation, and changes to the existing external-action retry policy.
