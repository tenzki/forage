## Context

See `proposal.md` for motivation and capability scope. The interaction reference is the latest saved `docs/desktop.pen`, incorporating the user's corrections through the standard provider dropdown and unified agent tool list.

`SettingsPanel.tsx` currently combines connection/authentication, global tool management, section visibility, and runtime diagnostics. `AgentSettings.tsx` contains inline agent/skill forms; `ExtensionsSettings.tsx` and the MCP components already provide management services that should be reused. `settingsStore.ts` stores portable agent definitions and non-secret preferences, while native SQLite owns local credentials. Server compute and credentials have independent authority.

Current model contracts and `packages/pi-runtime/src/runtime-auth.ts` support OpenAI API and ChatGPT authentication only. Additional provider rows therefore require runtime, native, protocol, and server work. A UI-only change would incorrectly advertise working connections.

Governing constraints: ADR-0014 (local credential storage), ADR-0017 (server configuration), ADR-0018 (environment compute profiles), ADR-0021 (extension trust), ADR-0022 (Pi execution and conversations), and ADR-0023 (environment-owned MCP clients).

## Goals / Non-Goals

**Goals:** implement the approved settings hierarchy and editing flows; preserve existing accounts and permissions; make provider setup work in both execution environments; keep extension and MCP authorization explicit; make all new controls accessible and recoverable after failed saves.

**Non-goals:** changing the outline/event model, installing third-party code through provider selection, automatic extension-created skills, a separate MCP execution-location setting, desktop configuration of backend MCP commands/secrets, new MCP transport/authentication types, per-agent model overrides, or redesigning result placement.

Remote icon fetching, integration catalogs, provider logo acquisition, custom provider endpoints, and multiple accounts for the same provider/authentication identity are outside this change. The account abstraction must not prevent later expansion, but the initial UI manages one configured account per supported provider/authentication identity. OpenAI API and ChatGPT remain distinct authentication identities.

## Design reference

| Node in `docs/desktop.pen` | Implementation responsibility |
| --- | --- |
| `uFKHO` | General, appearance preview, motion preference, version, Diagnostics link |
| `aP053` | Nested General / Diagnostics, replacing top-level Advanced |
| `UVrNy` | Connected accounts, Add provider, default compute, workspace connection/recovery |
| `KkS17` | Standard provider dropdown and provider-specific authentication form |
| `eDZqs` | Agents/skills, applicable built-in/custom global tools, Inbox rules |
| `o4cSYt` | Dedicated agent editor, source-labelled tools, per-server MCP selection |
| `xttSQ` | Extension inventory |
| `x7roQ`, `iO4yZ` | One extension detail template populated by System One/Text Stats metadata |
| `yD3fN` | Connected and detected MCP inventories with a single Add server action |
| `SOQOK` | MCP tool review, top-positioned refresh, expandable descriptions, agent access |
| `mYqK6`, `i7FjPu` | URL-first manual MCP setup and its command variant |

Provider names, version `0.1.0`, selected model, connection states, source clients, and the one-connected/two-detected example are illustrative data, not runtime constants. The screen IDs are references for review, not identifiers stored by the application.

Preserve the current cream/green visual system: paper `#F5F2E8`, raised paper `#FCFBF7`, ink `#203D32`, muted ink `#4A5E53`, moss `#64735B`, sage `#DCE3D3`, rule `#CBCFC0`, and soft rule `#E3E2D6`. Reuse existing buttons, fields, switches, section headings, status badges, and semantic CSS tokens. The Pen file uses Apfel Grotezk/IBM Plex Mono variables; newer inserted text uses Inter where Pen could not render Apfel. Follow the application's established font tokens rather than shipping a second font stack solely because of that editor limitation.

The 1440px artboards and approximately 640px content column describe hierarchy and spacing, not fixed viewport requirements. Use normal page scrolling for long lists, bounded inputs, responsive field rows, and proper truncation/disclosure for descriptions.

### Explicit mockup reconciliations

- `o4cSYt` still illustrates an inherited-model dropdown and override hint. ADR-0018 intentionally keeps agents model-agnostic. Implement a read-only inherited-model summary with Change in Connection, and update that mockup during implementation. Overrides require a separate architectural decision.
- General's older Run behaviour sketch contains activity-opening and Ask before placing results switches that are not established persisted settings in the current store. Do not ship nonfunctional switches or introduce a result-placement protocol in this redesign. Preserve current run behavior and remove these illustrative controls during implementation; a future run-behavior change can specify their effects across local/server execution.
- Provider and MCP setup illustrations primarily show local management. Provider forms follow the active environment's authority; backend MCP configuration remains operator-owned and its Add/Scan/Disconnect mutations are not exposed as desktop actions.
- Collapsed extension details must continue to expose compatibility, declared contributions, source identity, trust information, and sanitized errors even though the happy-path mockups omit most of that text.

## Decisions

### 1. Separate settings navigation from settings authority

Introduce a small typed settings navigation state covering section, nested page, and selected entity. Keep entity state and persistence in existing stores/services rather than copying them into navigation state. Resolve missing/deleted entities back to their list with a clear message. Opening Settings selects General; explicit internal links may target a nested page. Back/Cancel restores useful focus.

Split the monolithic panel into General, Connection, Agents, Extensions, and MCP views. Extract reusable agent/skill forms so extension Create skill and ordinary Agents actions use the same validation and save path. Dirty drafts require discard handling; do not mark a draft saved before authoritative persistence or server publication is confirmed. Preserve the existing distinction between a successful local save and a failed server publication.

Alternative: keep adding hidden sections and inline forms to `SettingsPanel`. Rejected because nested flows already span several entry points and lose parent/focus semantics.

### 2. Device presentation preferences stay outside portable configuration

Add a versioned, non-secret preferences record to local settings persistence. Theme is `system`, `light`, or `dark`; typography uses a small supported font enum mapped to application/system stacks and a bounded size selection (12, 14, 16, 18, 20, 24 px). Default values must reproduce the current outline appearance on upgrade; unsupported stored choices fall back safely. The display can show Default rather than exposing internal font names.

Apply theme through semantic tokens, and apply outline typography through scoped CSS variables shared by the editor and preview. Subscribe to system appearance/motion signals only when relevant. The preview is static sample content, not a second live document editor. Debounced/coalesced persistence must handle rapid changes without older writes winning; errors remain visible and retryable. No preference writes enter document events, portable agent configuration, or server synchronization.

Read application version through Tauri metadata with a deterministic test/dev adapter. Diagnostics retain reusable runtime checks but present user-facing connection categories first; technical versions and sanitized details live in a disclosure.

Alternative: store preferences on the outline or server. Rejected because these choices are device presentation and should not create document history or alter another device.

### 3. Provider registry plus environment-owned accounts

Use shared, explicit provider descriptors with stable provider/authentication IDs, human labels, supported authentication methods, runtime mapping, and model catalog access. Initial acceptance requires working Anthropic, OpenRouter, OpenCode Go, OpenAI API, and ChatGPT paths. Validate the exact provider IDs and supported models against the pinned Pi catalog; where a named provider needs an adapter, implement and test it before making that choice available. Do not infer an API endpoint from its display name or expose every catalog entry as supported authentication.

Connection renders only configured accounts. Add provider uses the existing standard Select/Field primitives; it is not a searchable card catalog. The selected descriptor chooses the credential form. Mask secret input, clear it after completion, disable duplicate submission, and use bounded provider-appropriate authentication validation rather than an arbitrary billable generation test. Authentication failures and network failures must remain distinguishable. Existing ChatGPT device login, cancellation, refresh, and revocation behavior remain intact.

Keep one active compute profile per environment, already shaped as provider/model/credential reference. Updating default provider/model validates and commits the combination atomically with revision checking on the server. A provider change does not briefly persist the old provider's model under the new provider. New connections do not implicitly switch compute. A removed default is shown as requiring repair; neither account order nor catalog order selects a replacement.

Extend shared provider/credential validation, native credential storage, sidecar payload construction, runtime authentication, server credential/profile services, and admission together. Reuse native/server secret stores and sanitized metadata; provider keys never move into plugin-store. Keep Pi runtime credentials in memory and scoped to the admitted account. Both local and server admission snapshot the resolved selection; active conversations retain the existing conversation/admission rules.

Expose the active environment's supported provider/model capability metadata so a desktop does not offer writes an older server cannot accept. Server setup submits credentials only through explicit provisioning/account actions, and Run never transfers them. Display the target workspace/server context as explanatory text, not a new environment selector.

Alternatives: hard-code more account rows, put credentials on agents, or ship only form changes. Rejected respectively for scaling, authority/portability, and falsely implying functional provider support.

### 4. One permission model, several clear editing surfaces

Retain the intersection of global enablement, agent selection, executor availability, and run policy. Built-in/custom tools keep their global policy surface in Agents; extension global tools move to their detail page; MCP global review stays on server details. The dedicated agent editor lists built-in/custom/extension tools with source labels and exposes MCP server rows with individual-tool review.

Do not persist a new Allow MCP tools master bit or a wildcard grant. A server row derives its selected count from individual tool IDs. Turning it off stages removal of that server's agent tool IDs. Turning it on opens Choose tools and requires an explicit selection; the draft can offer previously reviewed tools still valid in the current catalog, never automatically new definitions. Save uses existing agent/global grant services and current inventory revision checks. A globally disabled tool remains unavailable in the agent picker with a route to its source settings.

Unavailable saved references remain identifiable and cannot be silently dropped by unrelated edits. All draft editing remains distinct from effective authorization. A server change to tools while review is open invalidates affected selections and requires review again.

Alternative: persist server-wide or extension-wide permission toggles. Rejected because such grants would unintentionally include future tools and conflict with current per-definition MCP identity.

### 5. One extension detail template and explicit skill drafts

Populate identity/status/version, Configuration, Tools, Use in a skill, details, and lifecycle actions from the current extension catalog. Source-specific fields come only from declared app-rendered schemas. Empty states distinguish no configuration needed, no agent tools, and no skill actions. Preserve trust/revision/configuration gates even when technical details are collapsed.

Create skill opens the normal skill form with the generic executor reference preselected. The user supplies a unique slash label and bounded per-skill configuration. Cancel creates nothing; installation and enablement still create nothing. Missing required source configuration is explained before invocation; existing saved skills remain inspectable if the source later disappears. Core must not name System One or Text Stats as special execution types.

Remove Copy report buttons from extension pages. Keep sanitized error text selectable/copyable in details, preserving the existing error-inspection contract. The general Diagnostics report action serves its distinct support purpose.

Alternative: an extension-specific skill installer or bespoke detail component per extension. Rejected because both weaken the generic extension contract and recreate the inconsistency identified during design review.

### 6. MCP overview and setup build on the existing client

Reuse the management client, discovery sidecar, MCP store, and authority routing from `add-mcp-client`. Match connected imports to detected candidates using existing source/definition identities; do not deduplicate solely by display name. Changed candidates and differently configured servers with the same name remain distinguishable. Candidate scans never launch commands or acquire tool grants.

The overview provides Add server, connected rows, detected rows, and Scan again. Its dedicated URL-first setup page owns URL/token/headers, a command variant owns command/environment/cwd, and JSON is an optional disclosure. Keep separate method drafts and construct only the selected method's payload. Retain existing command execution/trust guidance and missing-credential prompts. Detected Connect takes the user to the same tool/agent review after successful import. Errors preserve retryable non-secret inputs and never expose secrets.

Backend mode renders operator-owned inventory with clear management limitations. It does not run local discovery, export backend configuration, or add backend mutation endpoints in this change. Permission editing uses authorized existing configuration paths.

Tool rows use a true one-line, ellipsized preview plus a keyboard-accessible disclosure. Descriptions are untrusted plain text, bounded before rendering; do not summarize them with a model. Refresh remains near the heading and does not authorize changed tools. Use a neutral plug icon consistently; icon metadata fetching is deferred so no server-provided image URI introduces a new network path in this redesign.

Alternative: keep the overview URL form and a second advanced form. Rejected because duplicate setup paths make required credentials and method changes harder to understand.

### 7. Compose with active OpenSpec changes

`mcp-settings` is a new presentation capability layered on the active `add-mcp-client` contract, which is not yet in canonical `openspec/specs`. Do not create a second `mcp-client` delta or archive that work as part of this proposal. Merge/archive the underlying MCP capability before or with this feature according to its own completion criteria.

Generic executor behavior is provided by `add-system-one-skills`. This change adds the explicit detail-page entry point and modifies only First-class Extensions settings and Dynamic catalog and retained configuration in canonical `local-agent-extensions`. Its other requirements and the active change's runtime/executor deltas remain intact. Coordinate with `run-pi-on-server` and `add-server-agent-executor` when widening provider contracts; do not duplicate their conversation or admission implementation.

## Risks / Trade-offs

- **Provider forms outpace runtime support** → make provider-specific contract and desktop/server execution checks release gates, including OpenCode Go; never ship a selectable nonfunctional provider.
- **Older clients reject new provider IDs** → deploy compatible shared/server contracts first, gate choices using server capabilities, and show an update-required error rather than silently normalizing an unknown provider.
- **Navigation hides a save or publication error** → retain dirty drafts and distinguish local persistence from server publication failure.
- **Permission relocation grants access** → migrate identities unchanged and test the existing effective allowlist before and after upgrade.
- **Mockups conceal missing/error states** → add explicit disabled, unavailable, empty, conflict, and partial-discovery cases to implementation verification.
- **Theme or typography breaks the outliner** → verify contrast, focus, selection, indentation, inline links, generated images, and narrow layouts in the native app using the existing document model.

## Migration Plan

1. Capture representative existing OpenAI/ChatGPT settings, credentials, compute profiles, agent tool selections, and extension/MCP references as migration fixtures. Preserve all unrelated working-tree changes.
2. Add shared provider descriptors and backwards-readable contract/storage support. Add explicit server capability reporting before exposing additional provider choices.
3. Introduce versioned local account metadata/preferences with an idempotent migration from `codexAuthMode`, `codexModelId`, and current credential metadata. Preserve existing credential IDs and keep secret bytes in their original protected stores. Existing server profiles remain valid without changing selected compute.
4. Ship settings navigation and new provider/runtime paths together. Move permission editing surfaces without rewriting stored permissions. Update the two illustrative mockup discrepancies above and document the behavior.
5. Verify local and server upgrades and native flows before release. Record actual commands/results in a change verification document during implementation; this proposal does not claim those checks have run.

Rollback is code rollback only while persisted provider selections remain supported by the previous version. Before downgrading after selecting a new provider, use the new version to explicitly select a legacy-compatible provider/model in each affected environment. Preserve a pre-upgrade settings/database backup and all new credential entries; do not silently rewrite unsupported selections, revoke credentials, or reset tool permissions to make an older build start. General preferences can remain stored and be ignored by older code.
