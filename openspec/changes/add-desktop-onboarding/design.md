## Context

See `proposal.md` for motivation and `specs/desktop-onboarding/spec.md` for the behavior contract. The interaction reference is `docs/desktop.pen`, screens 09A–09K: the minimal onboarding window, bottom-navigation skipping, and optional MCP connection setup after extensions.

`App.tsx` owns document loading, the editor, persistence callbacks, run observation, and shell presentation. `application/OutlineSession.ts` opens the canonical outline and creates an initial checkpoint when no replay input exists. `OutlinerEditor.tsx` supplies ordinary nesting, stable IDs, and durable undo. `agent/skillExecution.ts` supplies context admission and execution. Onboarding must compose these services without creating a second document or alternate run path.

Provider configuration is being extended by `redesign-settings`. `ProviderConnectionsSettings.tsx` currently owns UI and authentication orchestration; reusable forms/services will be needed rather than embedding all of Settings. `extensionStore.ts` already supports inventory, installation preview, source registration, configuration, and activation. Extension forms, tool grants, and skill drafts must retain ADR-0021/0022 and existing OpenSpec authority boundaries.

MCP setup reuses `mcpStore.ts`, its management client, native credential storage, and the `add-mcp-client` contract. Reuse the connected/detected inventory and manual forms from `redesign-settings`; per-definition tool review and assistant assignment remain in Settings. Retain ADR-0023 environment authority. Do not create a second MCP client or duplicate the active capability's deltas.

## Goals / Non-Goals

**Goals:** make first setup concrete using real notes and configuration; preserve durable content through navigation; reuse existing authority; keep startup, skipping, and resumption predictable.

**Non-goals:** a workspace tour, Activity conversations, mandatory extension or image demonstrations, server onboarding, new model adapters, a public marketplace, or new credential/persistence authority. The initial flow operates in local mode; existing server installations continue through their established Settings flows.

## Design reference

| Pen node | Screen/state | Responsibility |
| --- | --- | --- |
| `LMoVS` | 09A — First note | Instructions, real outline editing, keyboard hint, Continue |
| `rOqSH` | 09B — Connect AI | Provider/authentication controls and pending connection state |
| `JvarG` | 09C — AI connected | Verified account and explicit default-model selection |
| `HMvE9` | 09D — First command | Same note, editable `/brainstorm` request, explicit Run command |
| `KB98U` | 09E — First result | Actual output and normal editing |
| `fEDLl` | 09F — Pick extensions | Compatible choices; bottom Back, Skip for now, Configure selected |
| `eKkZt` | 09G — Configure extension | Selected source configuration, trust, access, and optional command creation |
| `W3XYY` | 09H — MCP connections | Detected/connected inventory, explicit scan/import, Add server, bottom skip |
| `Ta3uk` | 09I — MCP server URL | Named URL connection, optional token/headers, alternative method and JSON import |
| `c1SEGD` | 09J — MCP launch command | Named executable/arguments, optional environment/cwd, explicit local execution |
| `fHPd3` | 09K — Complete | Actual saved setup and MCP connection, route to later access configuration, Open Forage |

These are eleven presentation states within five steps. URL and command forms are alternatives, and optional configuration states depend on the user's choices. Reuse the paper/ink colors and existing controls. The 960×760 artboards and 560px content column indicate spacing and hierarchy; the implementation must scroll and adapt to smaller supported windows. Follow application font tokens rather than adding Inter solely because Pen used a rendering fallback.

### Mockup reconciliations

- Sample notes, selected extensions, account status, and `gpt-5-codex` are illustrative. Begin with a blank editable note, unselected extension choices, and the runtime-supported model catalog. Do not seed the depicted weekend project or assert a connection based on sample copy.
- Add an AI Skip for now action to bottom navigation for the optional connection step. Skipping unconfigured AI bypasses command execution and proceeds to extensions; skipping all setup enters the ordinary local workspace.
- The compact extension mockup omits installation preview and compresses tool policy. Expose source/revision review when installation is needed, keep new trust/grants unchecked, and distinguish global tool enablement from assignment to an assistant. Saving an extension does not create a skill implicitly.
- Codex login found is valid only when an extension-owned check establishes that fact. Where existing extension services cannot verify an external prerequisite, show configuration saved or the appropriate unresolved prerequisite rather than claiming verified readiness. Do not test setup by making a billable image request.
- Keep Skip for now in `fEDLl`'s bottom navigation, grouped with Configure selected; keep Back on the left. No skip action remains inside the extension list.
- MCP names, source clients, and detected candidates are illustrative. Initially show saved inventory or an explicit Find existing connections action; scanning is user-triggered. Onboarding grants no new tool access, and completion describes a connection without implying its tools are enabled for an assistant.
- MCP uses ordinary inputs rather than provider dropdowns. Additional headers, environment/cwd, and JSON import use accessible disclosures to keep the initial forms minimal. Detailed tool review remains in Settings → MCP servers. No MCP demonstration is required and connecting never invokes a tool to test it.

## Decisions

### 1. Present onboarding through the existing application owner

Add a small typed onboarding controller and view beneath `App`, with `note`, `ai`, `command`, `extensions`, and `mcp` steps plus pending/connected/result/configuration/review/completion substates. Render the minimal instructions and bottom navigation while suppressing the ordinary shell chrome. Keep the application-owned session, editor authority, persistence, and run observation alive across presentation changes.

The note, command, and result screens reuse the same editor instance. Configuration screens hide its presentation without replacing its document. Capture the first user note's stable ID and use existing zoom/focus facilities to show the relevant branch. Entering the ordinary workspace reveals the same document and useful note focus.

Alternative: a separate wizard note buffer or editor followed by an import on Finish. Rejected because it creates duplicate content, undo, and durability paths.

### 2. Persist progress separately and gate first-run eligibility before bootstrap

Introduce a versioned non-secret device-local onboarding record, separate from portable agent settings: status (`in-progress`, `paused`, `skipped`, `completed`, or `not-offered`), current step, outline/note/invocation/run references, selected source identities, MCP connection/candidate references, and per-step skipped markers. Secret drafts, note text, transcripts, effective grants, MCP commands, environment values, tokens, and headers stay outside this record. Serialize writes and expose retryable progress-save failures.

Capture whether durable replay/settings existed before first-start initialization writes defaults. `OutlineSession.open` can expose whether it created the initial local outline from absent replay; combine this with pre-initialization settings evidence and storage mode. Existing durable installations without a record receive not-offered and retain ordinary startup. Never infer freshness from a failed read or an empty document alone. The schema marker is not synchronized.

On restart, in-progress resumes after successful hydration. Explicit pause opens the workspace and leaves resumption to General settings. Completed/skipped never opens automatically. Resume resolves references against authoritative state; missing targets return to the appropriate repair step. Invalid progress records do not block opening valid notes or trigger a reset. General settings provides Start setup/Resume setup; server mode explains that this local flow is unavailable without switching environments automatically.

Alternative: one completed boolean and an empty-outline check. Rejected because it cannot distinguish upgrades, pauses, partial setup, or failed reads.

### 3. Reuse provider setup and confirm compute separately

Extract reusable provider authentication controls and actions from the Settings redesign, preserving connection validation, cancellation, sanitized errors, and secret cleanup. Use the local supported-provider descriptors/model catalog. An account save is distinct from the user's confirmation of the default provider/model/credential combination; onboarding commits the latter through the existing atomic selection path.

Already usable local connections can be reused with explicit confirmation. Back preserves committed accounts and clears secret drafts; incomplete authorization is canceled rather than replayed on resume. Onboarding does not enroll a server or copy credentials between environments. The first actual user-requested command is the inference check; setup does not make a hidden generation request.

Alternative: bespoke onboarding authentication or an assumed first connected default. Rejected because both can diverge from current account authority and selection rules.

### 4. Invoke skills once through ordinary admission

Focus a new invocation beneath the stored first-note target and offer an editable `/brainstorm` request. Both Enter and Run command dispatch through the existing skill execution service. Coordinate keyboard/form handling so a gesture fires once; a running invocation cannot be submitted again accidentally. Use the ordinary context preview or compact context summary to identify what is sent.

Persist the invocation/run references and derive pending, failed, interrupted, and committed-result states from run/document authority. Revisiting displays existing output. A new retry is explicit and follows existing cleanup/retained-result rules. Durable note edits must be acknowledged before step advancement; output success follows the existing result commit contract. Skipping/presentation changes preserve existing run observation and cancellation semantics; completed output is not reset by Back.

Alternative: synthetic demo output or calling the SDK directly from a wizard component. Rejected because neither verifies the real workflow and both bypass established policy and result handling.

### 5. Compose extension setup from existing services

Build a small local choice list from installed manifest inventory and explicit descriptors for compatible first-party packages shipped with the desktop. Resolve shipped sources through application resources, never a developer repository path. Ensure manifests and built entries actually ship before advertising installable choices. Startup/choice rendering stays manifest-only and performs no registry access or imports. This is a bounded selection list, not a public catalog service.

Configure selected prepares one source at a time. For an absent source, use existing preview/source review and an explicit installation confirmation before registration. Then reuse app-rendered configuration, source trust/enablement, individual global tool grants, assistant selection, and the normal skill draft/save path. Defaults never include new trust or tool grants. Maintain separate state for installation, saved configuration, source activation, tool access, and optional command creation; retry resumes from authoritative successful operations without reinstalling or duplicating skills.

Image Generation remains an extension with its own credentials; Text Stats and System One are catalog examples, not core execution types. Use contribution metadata and existing generic executor forms. Where an optional source or skill needs further prerequisites, show that status and allow skipping. Extension skipping does not roll back previously saved setup and does not install pending selections.

Completing or skipping extension setup proceeds to MCP. The user can still skip all remaining setup and open the workspace.

Alternative: one install-and-enable helper with automatic tools and slash commands. Rejected because selection is not source trust, tool permission, or skill creation.

### 6. Configure MCP with the existing local client

Present MCP as optional step five after extensions. Load saved local inventory without launching connections. Offer Find existing connections/Scan again explicitly; scanning uses bounded supported user-level client files and returns sanitized metadata without execution. Distinguish connected entries from candidates, including empty/partial scan states. Candidate Connect revalidates source identity and prompts for missing supported credentials; import does not modify the originating client's files.

Add server opens a URL-first named form with optional token/headers, a Launch command alternative with arguments/environment/cwd, and a collapsed JSON import. Keep drafts separate and submit only the selected method. Connect is the explicit action permitting endpoint discovery or launching the supplied command; show the existing execution/trust guidance before command connection. Clear secret drafts on leaving the form. Use the same URL validation, native secret references, bounded discovery, and duplicate-connection checks as Settings. This does not require a model credential.

After discovery, return to the configured inventory. Show a concise connected status and explain that tool access is configured later in Settings → MCP servers. Keep the existing individual global/assistant grant forms there; onboarding has no detailed permissions screen, tool selections, or Save access action. Preserve definition-bound identities and existing policy with no wildcard server grant, preset integration, separate MCP environment selector, or automatic grants on connect/refresh. Changed definitions still invalidate affected grants and require renewed review through Settings.

Back/Skip preserves connections already explicitly saved and discards unsaved connection drafts. Restart/resume displays authoritative saved inventory, never auto-connects or launches commands, and never replays tool calls. Uncertain failures require fresh action; connection setup uses metadata discovery only and no model or tool execution. The completion summary distinguishes connected, skipped, and needs-attention states, with a route to later tool configuration.

Alternative: auto-import all detected clients and enable their tools for the default assistant. Rejected because discovering configuration is not connection or tool authorization and source definitions can change.

### 7. Complete from actual state and retain local usefulness

The final summary uses saved note/run/account/extension/MCP state and labels skipped or unresolved capabilities honestly. A saved MCP connection with no access is described as connected with access unconfigured, not available to an assistant. Open Forage saves the terminal marker before dismissing onboarding. If that marker cannot be saved, show retry and keep normal local editing reachable; do not label the onboarding completed prematurely.

No step requires successful optional extension or MCP setup to enter the workspace. No AI account is required for local notes or MCP discovery/configuration. A skipped command is not represented as an agent result.

Alternative: completion gated on every provider/extension check. Rejected because it makes offline note-taking depend on optional services.

## Risks / Trade-offs

- **Step navigation remounts or reseeds the editor** → keep editor/session authority under `App`; verify stable IDs, one event capture, undo, and restart across the transition.
- **Default bootstrap obscures an existing installation** → capture durable/settings existence before initialization and test fresh, empty-existing, upgraded, corrupted, and server cases.
- **Minimal screens hide partial failures** → show bounded inline error/status details and retain retry/skip actions; never infer success from a wizard counter.
- **Package examples are absent from distribution** → build/package first-party resources and verify a clean signed-app installation without repository paths; omit unavailable choices.
- **Convenient setup broadens extension authority** → use separate explicit source/trust/tool/skill controls and test no side effects on selection, Back, or Skip.
- **MCP discovery becomes execution or permission** → trigger scans/connects separately, retain source/definition checks, and verify no launches, imports, grants, or tool calls occur on entry/resume/skip.
- **Settings or pane work lands concurrently** → share extracted provider/forms services with `redesign-settings` and preserve canonical document ownership with `add-multi-pane-workspace`; avoid duplicating either change.

## Migration Plan

1. Land compatible shared setup forms from `redesign-settings`, reuse the `add-mcp-client` services, and identify supported first-party distribution resources.
2. Add the onboarding record and pre-bootstrap eligibility signal; treat existing installs as not-offered without changing accounts, permissions, document events, or execution mode.
3. Add the minimal shell and connect the five steps through existing authorities. Keep General's manual entry available for verification and resumption.
4. Verify native fresh-start, skip, restart, upgrade, real command execution, multi-extension partial failure, MCP scan/connect without new grants, and the Settings route for later permissions; record evidence during implementation.
5. Ship onboarding after those checks pass. Rolling back ignores the onboarding record while retaining ordinary notes, credentials, skills, extension configuration, and MCP connections/permissions; no reverse document migration or credential revocation is needed.
