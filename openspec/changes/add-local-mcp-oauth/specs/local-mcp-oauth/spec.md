## Purpose

Let desktop users authorize compatible HTTP MCP servers through browser consent without manually creating tokens, while preserving device-local credentials, explicit tool permissions, and safe execution recovery.

## ADDED Requirements

### Requirement: Explicit local HTTP authentication methods
Local HTTP MCP setup SHALL offer Browser sign-in, Manual credentials, and None. Each method SHALL retain its own draft and submit only its selected configuration. Existing configurations SHALL retain their authentication meaning unless explicitly changed. Launch-command setup SHALL remain unchanged.

#### Scenario: Switch authentication methods
- **WHEN** a user switches from Manual credentials to Browser sign-in
- **THEN** the browser flow excludes the manual token and Authorization header
- **AND** returning to Manual credentials restores its unsaved draft without submitting browser credentials

#### Scenario: Existing manual connection
- **WHEN** a saved header/token configuration without an OAuth descriptor is loaded or returns an authentication error
- **THEN** Forage preserves its manual behavior and does not automatically initiate OAuth

#### Scenario: No authentication
- **WHEN** the user explicitly selects None
- **THEN** Forage submits no authorization credential from another draft and connecting still requires permission review

### Requirement: Generic metadata-driven authorization
Browser sign-in SHALL discover and validate the MCP resource's authorization metadata and a supported public-client registration method without a hardcoded provider integration. Unsupported registration, grant, or authentication requirements SHALL produce bounded actionable errors rather than impersonation or security downgrade.

#### Scenario: Compatible unknown provider
- **WHEN** a user explicitly starts browser sign-in for a compatible server without a Forage preset
- **THEN** Forage obtains an appropriate client identity and prepares authorization using validated server metadata
- **AND** the user does not need to create or paste an API token

#### Scenario: Registration requires configuration
- **WHEN** automatic public-client registration is unavailable but an explicitly configured supported public client ID or metadata URL can be used
- **THEN** Forage uses that configuration without borrowing another application's identity

#### Scenario: Browser sign-in unsupported
- **WHEN** the server cannot support Forage's browser authorization flow
- **THEN** Forage explains the limitation and offers an explicit switch to Manual credentials or None
- **AND** it neither silently changes authentication nor grants tools

### Requirement: User-initiated system-browser consent
Forage SHALL initiate interactive consent only after an explicit user action and SHALL use the system browser rather than an embedded login page. Browser/link actions SHALL be bound to the active authorization request and SHALL NOT accept arbitrary unvalidated destinations.

#### Scenario: Start sign-in
- **WHEN** a user selects Sign in and connect for a validated compatible endpoint
- **THEN** Forage opens the active authorization URL in the system browser and shows a waiting state

#### Scenario: Agent cannot request consent
- **WHEN** a run needs missing credentials or additional scopes
- **THEN** it fails with a sanitized actionable status without opening a browser or consent listener

### Requirement: Authorization response binding
Authorization SHALL use PKCE S256, unpredictable per-request state, and a bounded loopback callback bound to the selected connection/resource and validated issuer. Callbacks SHALL be validated and consumed at most once before code exchange. Credentials SHALL NOT be accepted from mismatched, expired, cancelled, or replayed callbacks.

#### Scenario: Valid callback
- **WHEN** the active authorization request receives a valid matching callback
- **THEN** Forage exchanges the code for the bound resource and closes the callback listener

#### Scenario: Invalid or replayed callback
- **WHEN** state, callback binding, or a present issuer does not match, a required issuer is missing, or the callback has already been consumed
- **THEN** Forage rejects it without exchanging its code, committing credentials, or granting tools

### Requirement: Waiting recovery and cancellation
During authorization, Forage SHALL freeze the connection fields, offer recovery actions for the active request, and permit cancellation. Cancellation, leaving setup, switching connection/method/workspace mode, disconnecting, application exit, and deadline expiry SHALL terminate pending authorization and invalidate late results while preserving applicable unsaved draft values.

#### Scenario: Browser recovery
- **WHEN** the user chooses Open browser again or Copy sign-in link while waiting
- **THEN** Forage reopens or copies only the active authorization URL without creating a second consent request or exposing token responses

#### Scenario: Cancel or time out
- **WHEN** pending sign-in is cancelled or its deadline expires
- **THEN** its listener/process is cleaned up and late callbacks/results cannot save authorization
- **AND** a retry requires a fresh explicit request rather than resuming an expired request

### Requirement: Atomic new-connection completion
A new OAuth connection SHALL be reported as connected only after validated authorization, successful bounded tool discovery, and durable local credential/metadata persistence. Failure or cancellation before completion SHALL create no saved connection or grants and SHALL clear staged secrets.

#### Scenario: Connection succeeds
- **WHEN** authorization, discovery, and persistence all complete successfully
- **THEN** Forage saves the connection locally and opens explicit access review

#### Scenario: Discovery or storage fails after consent
- **WHEN** consent succeeds but discovery or local persistence fails
- **THEN** Forage reports the failed connection without enabling tools or leaving usable staged credentials
- **AND** it does not claim that provider-side consent has necessarily been revoked

### Requirement: Consent does not grant tool access
OAuth consent SHALL NOT authorize tools in Forage. New connection review SHALL start with new tool and agent selections unchecked. Save access SHALL apply only explicitly reviewed global tool enablement and additive agent grants, without removing unrelated existing permissions.

#### Scenario: Review after consent
- **WHEN** browser sign-in creates a new connection
- **THEN** the discovered tools remain unavailable to agents until the applicable global and agent permissions are explicitly saved

#### Scenario: Cancel review
- **WHEN** the user cancels access review after a successful connection
- **THEN** the connection and authorization remain saved without any additional grants

#### Scenario: Global-only save
- **WHEN** a user saves selected tools without selecting an agent
- **THEN** Forage can enable those tools globally without implicitly assigning them to any agent

### Requirement: Connection-scoped native authorization ownership
OAuth credentials and sensitive registration material SHALL remain device-local behind the native credential boundary and SHALL be bound to the connection, resource, and issuer. Ordinary settings, portable agent configuration, outline data, model context, logs, diagnostics, activity, and onboarding progress SHALL NOT contain tokens, callback codes, PKCE verifiers, registration secrets, or authorization URLs.

#### Scenario: Settings or diagnostics inspected
- **WHEN** metadata, tool descriptions, diagnostics, or activity are displayed or exported
- **THEN** they contain only admitted non-secret status/metadata and no OAuth secret or active authorization URL

#### Scenario: Independent connections
- **WHEN** two connections share a provider name or issuer but have different connection/resource bindings
- **THEN** authorization for one is not implicitly reused or granted to the other

### Requirement: Serialized durable token refresh
Forage SHALL refresh expiring authorization noninteractively when supported, serialize credential rotation for each connection, persist new credentials durably before relying on them, and reject stale writes. Refresh SHALL NOT change tool permission identities or grants. Ambiguous rotating-token exchanges SHALL NOT be automatically replayed.

#### Scenario: Concurrent runs need refresh
- **WHEN** multiple runs need fresh authorization for the same connection
- **THEN** they coordinate one refresh and use its committed credential version without overwriting a newer rotated token

#### Scenario: No replacement refresh token
- **WHEN** a successful refresh response omits a replacement refresh token
- **THEN** Forage retains the previous usable refresh token rather than clearing it solely because the field was omitted

#### Scenario: Interrupted rotation
- **WHEN** refresh times out after the provider may have consumed a rotating refresh token, or its result cannot be persisted safely
- **THEN** Forage reports the uncertain/unavailable authorization without replaying the exchange or an MCP action

### Requirement: Explicit reauthentication preserves reviewed policy
Expired, missing-refresh, revoked, or otherwise invalid authorization SHALL make tools unavailable and offer explicit Sign in again. Existing saved tool/agent selections SHALL be retained without authorizing execution. Successful interactive reauthentication SHALL preserve the connection identity, revalidate inventory, and require explicit access review before reactivating prior selections for the possibly different account/site.

#### Scenario: Sign-in required
- **WHEN** authorization cannot be renewed safely
- **THEN** Settings shows saved permissions read-only with Sign-in required and agents cannot execute the connection's tools

#### Scenario: Reauthenticate successfully
- **WHEN** a user completes Sign in again
- **THEN** Forage keeps the connection ID and stages existing saved selections for explicit account-access review, including tools with updated definitions on the same binding
- **AND** newly discovered tools remain ungranted until selected and saved
- **AND** no prior failed run is resumed or replayed

#### Scenario: Temporary authorization service outage
- **WHEN** a network/provider failure does not establish that consent is invalid
- **THEN** Forage reports an unavailable connection without deleting credentials or treating the outage as confirmed revocation

### Requirement: Authentication must not replay external actions
OAuth integration SHALL preserve the existing no-automatic-replay policy for MCP calls and MCP-enabled turns, including SDK authentication retry paths. Scope escalation and recovery SHALL require explicit action and SHALL NOT automatically repeat a sent MCP request.

#### Scenario: Unauthorized response to a tool call
- **WHEN** a sent MCP tool request returns an authorization/scope error or uncertain transport failure
- **THEN** Forage reports the failure without refreshing-and-replaying that request, opening a browser, or restarting the turn

#### Scenario: Refresh before transmission
- **WHEN** an access token must be refreshed before an MCP request is sent
- **THEN** Forage can resolve fresh authorization first and issue the admitted request once

### Requirement: Disconnect prevents authorization resurrection
Disconnect SHALL invalidate pending authorization/refresh work, prevent new credential resolution, remove local credentials/configuration, and deauthorize the connection's tools. Remote revocation SHALL be bounded and best-effort when supported; it SHALL NOT prevent local removal or imply that already performed external actions were undone.

#### Scenario: Late refresh or callback after disconnect
- **WHEN** disconnected work returns an authorization result
- **THEN** that result cannot recreate credentials, a connection, or grants

#### Scenario: Provider revocation fails
- **WHEN** remote revocation is unavailable or fails
- **THEN** local disconnect still completes and Forage does not claim provider-side consent was revoked

### Requirement: Bounded and constrained authorization networking
Forage SHALL constrain authorization destinations, resource/issuer bindings, schemes, redirect behavior, response sizes, deadlines, and private-network access. It SHALL keep static MCP headers and tokens out of unrelated discovery/authorization requests and SHALL display only sanitized provider errors.

#### Scenario: Unsafe metadata destination
- **WHEN** remote metadata advertises an invalid issuer, insecure endpoint, credential-bearing redirect, or unauthorized private/loopback destination
- **THEN** Forage rejects that authorization flow without sending credentials to the destination

#### Scenario: Oversized or secret-bearing response
- **WHEN** metadata or an OAuth response exceeds limits or includes sensitive diagnostic material
- **THEN** Forage fails with a bounded sanitized error rather than retaining or exposing the raw payload

### Requirement: Local scope and compatible existing setup
OAuth SHALL apply only to explicitly configured local HTTP connections in this change. Backend inventory/ownership, static manual authentication, stdio behavior, and existing permission/admission checks SHALL remain unchanged. Discovery/import SHALL NOT copy another client's OAuth credential database or initiate consent during scanning.

#### Scenario: Server mode
- **WHEN** the workspace uses server execution
- **THEN** desktop OAuth setup and callbacks are absent and no desktop authorization is uploaded or used as fallback

#### Scenario: Scan another client
- **WHEN** Forage scans or imports an OAuth-capable endpoint from another client
- **THEN** it reads only supported connection configuration and requires explicit independent Forage authorization before using OAuth
- **AND** scanning itself opens no browser and grants nothing

### Requirement: Pen-aligned truthful presentation
Local OAuth setup, waiting, connected review, failure, reauthentication, and manual fallback SHALL follow the corresponding Pen states while displaying real sanitized connection/inventory status. Descriptions SHALL expand independently of permissions, and illustrative provider/tool labels SHALL NOT imply verified branding or read-only execution guarantees.

#### Scenario: Consolidated provider tools
- **WHEN** a server exposes generic discovery/execution tools rather than separate Jira read/write tools
- **THEN** Forage renders the discovered definitions and warns about external effects without inventing a read-only permission split

#### Scenario: Keyboard-only recovery
- **WHEN** a user operates sign-in, cancellation, recovery links, and review with the keyboard
- **THEN** focus and status changes remain accessible and expanding descriptions does not toggle grants
