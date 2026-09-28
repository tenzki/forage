## 1. Contracts and migration foundation

- [ ] 1.1 Reconcile integration points with `add-mcp-client`, `add-system-one-skills`, `run-pi-on-server`, and `add-server-agent-executor`; verify a written dependency checklist identifies shared files and avoids duplicating their runtime changes.
- [ ] 1.2 Define provider descriptors and validate exact Anthropic, OpenRouter, OpenCode Go, OpenAI, and ChatGPT mappings/authentication methods against the pinned Pi runtime; verify a provider matrix and focused catalog/adapter tests cover every advertised choice.
- [ ] 1.3 Extend shared compute/credential schemas and supported-provider capability metadata without changing portable agent definitions; verify legacy profile fixtures pass and unsupported combinations are rejected.
- [ ] 1.4 Add idempotent migration for local account metadata and device preferences; verify fixtures retain OpenAI/ChatGPT credential IDs, selected model/authentication, and all tool references across repeated migration.

## 2. Functional provider connections

- [ ] 2.1 Extend native local credential operations and sidecar authentication payloads for supported API-key providers while retaining ChatGPT OAuth behavior; verify secret-storage/redaction tests and existing login, refresh, and revocation tests pass.
- [ ] 2.2 Extend Pi runtime authentication/model resolution and any required provider adapters; verify each supported provider receives only its admitted credential and unsupported provider/model combinations fail before a model call.
- [ ] 2.3 Extend server provider credentials, profile validation, capability reporting, and admission snapshots; verify API/repository tests cover atomic profile changes, revision conflicts, unavailable credentials, and unchanged admitted runs.
- [ ] 2.4 Implement bounded provider-specific connection validation and sanitized metadata/error responses; verify success, invalid credentials, timeouts, cancellation, and no secret leakage using deterministic provider fixtures.
- [ ] 2.5 Implement connected-account rows, standard Add provider dropdown/forms, Manage actions, and default provider/model selection; verify component tests cover setup cancellation, failed validation, disconnecting the default, and older-server capability limits.

## 3. Settings hierarchy and General

- [ ] 3.1 Extract section/nested-page navigation with General first and no top-level Advanced; verify section order, parent selection, missing-entity fallback, Back navigation, and focus return in component tests.
- [ ] 3.2 Implement persistent theme, outline font/size, static preview, and system-motion preference; verify system appearance changes, rapid preference saves, persistence failures, restart defaults, and absence of document/portable-configuration writes.
- [ ] 3.3 Add application-version metadata and nested Diagnostics with sanitized reports; verify the version comes from the runtime adapter and check failures do not expose credentials or block other component results.
- [ ] 3.4 Move server readiness/recovery into Connection and retain Inbox rules in Agents; verify provisioning, conflict recovery, publication errors, and no-local-fallback behavior with existing server settings tests.
- [ ] 3.5 Reconcile the agent model-override and unsupported Run behaviour mockup controls with `design.md`; verify `docs/desktop.pen` and implementation show inherited compute and no nonfunctional result-placement switches.

## 4. Agent and extension editing

- [ ] 4.1 Extract reusable agent/skill editing flows with explicit Save/Cancel and dirty-draft handling; verify cancel, validation errors, publication failures, and edits during admitted runs preserve their respective saved/admitted state.
- [ ] 4.2 Render built-in/custom/extension tools in one agent list with source labels and retained unavailable references; verify global policy and trust gates remain effective after editing unrelated fields.
- [ ] 4.3 Add per-server MCP access and Choose tools without a master toggle or wildcard grants; verify first enablement requires review, cancel grants nothing, disabling affects only that agent, and new/changed definitions remain unauthorized.
- [ ] 4.4 Implement one metadata-driven extension detail template with configuration, global tool policy, agent access, empty states, and collapsed technical/trust/error details; verify System One, Text Stats, missing, untrusted, and incompatible fixtures use the same structure without loading extension UI.
- [ ] 4.5 Add Use in a skill → Create skill through the ordinary skill editor; verify no skill is created on activation or cancel, invalid/duplicate labels are rejected, and missing source configuration prevents execution.
- [ ] 4.6 Remove extension Copy report actions while preserving inspectable/copyable sanitized errors; verify both extension examples and error states satisfy the updated detail contract.

## 5. MCP settings flows

- [ ] 5.1 Separate connected and detected inventories, source labels, status, and discovery actions; verify mixed/empty/partial/error inventories, unchanged imported-candidate deduplication, and distinct configurations sharing a name.
- [ ] 5.2 Route Add server to URL-first setup with command and collapsed JSON alternatives; verify method-specific payloads, optional credentials/headers/environment/cwd, validation errors, and cancel preserve correct state without granting access.
- [ ] 5.3 Connect detected candidates into explicit tool/agent review using existing import validation; verify changed-source rejection, missing credentials, unsupported source options, and failed permission saves remain actionable and secret-free.
- [ ] 5.4 Implement compact one-line tool previews, independent accessible expansion, top-positioned Refresh tools, and neutral server icons; verify long/untrusted descriptions, missing icons, keyboard operation, and changed-inventory review.
- [ ] 5.5 Adapt all MCP pages to persisted server mode and operator-owned inventory; verify local scan/add mutations are absent, authorized permission edits still work, and backend errors never expose desktop fallback inventory.

## 6. Integrated verification and documentation

- [ ] 6.1 Run focused desktop settings/store tests, shared provider/runtime tests, server contract tests, and affected native credential tests; record commands and outcomes in `verification.md`, using only the dedicated contract-test database for destructive database tests.
- [ ] 6.2 Run `pnpm build` and the applicable existing regression suites after focused checks pass; verify no TypeScript, sidecar, server, or native integration regression remains.
- [ ] 6.3 Verify the real Tauri app against the referenced Pen screens in local and server modes: preferences/restart, provider setup/default changes, agent saves, extension skill creation, and MCP connection/review; record observed results, including keyboard focus, narrow layouts, long descriptions, contrast, and failure states.
- [ ] 6.4 Exercise upgrade fixtures and downgrade preflight with local/server account separation; verify permission identities are preserved, no credentials transfer implicitly, and unsupported selections fail visibly rather than resetting.
- [ ] 6.5 Update architecture/settings/provider/MCP documentation and reconcile design references with implemented behavior; verify links and record any intentionally deferred functionality without claiming it is available.
- [ ] 6.6 Run `openspec validate redesign-settings --strict --no-interactive` and review the final capability deltas against dependent changes; verify all requirements have implementation evidence before marking these tasks complete or archiving.
