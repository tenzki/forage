# Design

## Context

See [proposal.md](proposal.md) for motivation and scope. The current integration provides a useful execution engine but not an appropriate public extension boundary:

- `apps/desktop/src-tauri/resources/pi/sidecar/index.ts` embeds Pi 0.84.2 and creates an in-memory session for each invocation. Its loader and tool types are Pi-specific, and its current built-in tool list is not completely filtered by the configured allowlist.
- `apps/desktop/src/agent/piSdkClient.ts` starts the sidecar with model credentials. Its protocol supports run and abort, not credential-free extension inventory or management.
- `definitions.ts` and `settingsStore.ts` validate agents against a static built-in/custom catalog and discard unknown tool IDs.
- Settings currently has Connection, Agents, and Advanced views. Agents, skills, global tools, and custom HTTP tools share the Agents view.
- `packages/agent-runtime` and the server use a separate portable executor. Execution follows storage authority: local extensions must not cause server-mode work to run on the desktop.
- `pnpm-workspace.yaml` already includes `packages/*`; Turbo runs package build scripts, and the root Vitest setup defaults to a browser environment.

Pi's extension model is useful inspiration because registration is code-first and additive: an entry function receives a host API, registers tools, and subscribes to lifecycle events. Its concrete API, manifests, terminal UI assumptions, and package lifecycle are not Forage's product contract.

## Goals / Non-Goals

**Goals:** Define a small Forage-native extension format and API, let users understand and manage extensions inside the app, keep tool policy deny-by-default, support an inspectable local authoring loop, and keep managed updates recoverable.

**Non-Goals:** Pi compatibility, a general desktop plugin framework, arbitrary extension UI, an OS sandbox, a portable server extension runtime, or changes to the outline data model.

## Decisions

### 1. Own a versioned manifest and API

Every extension root contains `forage.extension.json`. The first manifest version has this shape:

```json
{
  "$schema": "https://forage.app/schemas/extension-manifest-v1.json",
  "manifestVersion": 1,
  "id": "dev.forage.text-stats",
  "name": "Text Stats",
  "version": "0.1.0",
  "description": "Counts words and characters in bounded text.",
  "entry": "./dist/index.js",
  "apiVersion": "1",
  "contributes": {
    "tools": [
      {
        "id": "text_stats",
        "name": "Text statistics",
        "description": "Count words and characters in text."
      }
    ],
    "hooks": [],
    "settings": []
  }
}
```

The manifest is declarative and safe to inspect without importing the entry module. It provides stable identity, compatibility, display metadata, and a preview of declared contributions. Paths must remain inside the extension root. Managed packages use built JavaScript entries; explicitly registered local development sources may use TypeScript entries through the host's pinned development loader.

`@forage/extension-api` exports types and a `defineExtension` helper. An entry module default-exports a setup function in this style:

```ts
import { defineExtension } from '@forage/extension-api'

export default defineExtension((forage) => {
  forage.registerTool({
    id: 'text_stats',
    name: 'Text statistics',
    description: 'Count words and characters in text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 20_000 } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(input, context) {
      context.signal.throwIfAborted()
      return { text: `Words: ${(String(input.text).match(/\\S+/gu) ?? []).length}` }
    },
  })
})
```

The v1 host API supports tool registration, bounded text/JSON tool results, progress reporting, structured logging, and documented `run:start`/`run:end` hooks. Tool execution and lifecycle callback contexts provide read-only access to declared settings and secret values. The registration callback receives no secret values, keeping catalog validation deterministic and model-credential-free. The API does not expose editor objects, direct outline mutation, model-provider replacement, terminal rendering, or the Pi session/API. `emit_outline` remains application-owned.

Runtime registrations must exactly match the manifest's declared tool IDs and hooks. Any missing or undeclared contribution fails validation closed, and an extension cannot mutate its manifest identity at runtime. The API and manifest versions are checked independently so their evolution remains explicit.

### 2. Separate the public API from reference extensions

Create these workspace projects during implementation:

```text
packages/extension-api/
├── package.json          # @forage/extension-api
├── src/index.ts          # public types and defineExtension
├── tests/
└── tsconfig.json

packages/extensions/
├── package.json          # @forage/extensions; private reference collection
├── forage.extension.json
├── src/index.ts          # text_stats reference extension
├── tests/
├── README.md
├── tsconfig.json
└── vitest.config.ts      # Node environment, no desktop test setup
```

`@forage/extension-api` has no dependency on Pi, React, Tauri, or desktop internals. Its runtime helper is deliberately small; validation remains host-owned. `@forage/extensions` depends on the API through the workspace and demonstrates the same manifest and loader path used by external packages.

The reference `text_stats` tool accepts bounded text and returns defined word and character counts. It needs no filesystem, network, model, or secret access. Explicit build, typecheck, and Node-environment test scripts participate in Turbo and repository verification without duplicate jsdom execution. Both packages remain private until publishing is separately designed.

### 3. Use one explicit user configuration root

Start with `~/.forage/settings.json`, `~/.forage/extensions/`, and a managed installation area under `~/.forage/packages/`. A drop-in extension is a directory containing `forage.extension.json`; loose executable files are not an extension format. The UI can open the folder and register an absolute local source directory. Configured relative paths resolve against `~/.forage`, never the process working directory.

Version the Forage-owned configuration and retain source registrations, enabled entries, trust acknowledgements, resolved package metadata, and non-secret extension settings there. Store it atomically and serialize concurrent mutations. Preserve invalid files and show diagnostics rather than silently regenerating configuration. Secret extension settings use the existing native credential boundary and are passed only to admitted local processes.

An extension source has a stable opaque installation ID in addition to its manifest extension ID. Local source registration canonicalizes paths and deduplicates repeated references. Trust applies to the accepted path and declared extension identity, including subsequent developer edits loaded through Reload; the UI explains that scope. An explicit managed-package update authorizes a replacement revision. Discovered sources remain disabled until reviewed and accepted.

Do not read the legacy `pi-agent` directory, `~/.pi`, ambient `.pi`, ambient `.forage`, AGENTS files, prompt files, or skills as extension inputs. Do not infer a project directory from a SQLite outline. Project-associated discovery can be a later change once folder association exists.

### 4. Give extensions a first-class Settings surface

Add a fourth top-level Settings view: Connection, Agents, Extensions, Advanced. Extension lifecycle does not belong inside the agent editor, and placing it only under Advanced would hide a user-facing capability. A separate non-Settings extension browser is premature without a marketplace.

The initial layout is:

```text
Settings  [Connection] [Agents] [Extensions] [Advanced]

Extensions                         [Install…] [Open folder] [Refresh]
Manage trusted local code. Enabling an extension can run code on this device.

Needs review (1)
┌ Weather Tools · Local folder · Not trusted               [Review] ┐

Installed
┌ Text Stats · 0.1.0 · Ready · 1 tool enabled             [Details] ┐
┌ GitHub Tools · 1.4.2 · Needs configuration              [Details] ┐
└ Broken Example · Error · entry could not load           [Details] ┘
```

The list shows name, version/revision, source kind, status, update state when explicitly checked, contribution counts, and a short diagnostic. Statuses include Needs review, Disabled, Needs configuration, Ready, Incompatible, and Error. The Extensions tab shows a subtle count badge for sources needing review or attention; discovery does not open a modal on startup.

Install opens a focused flow for an npm specification, Git URL/ref, or local directory. Before installation/registration it previews the manifest when available, source, resolved revision, declared tools/hooks/settings, and the trusted-code warning. Installation does not enable the source. Review/Enable is a separate confirmation.

Details is a nested Settings view with:

- manifest identity, source, version, API compatibility, and local path;
- declared tools and lifecycle hooks, including whether each tool is globally authorized;
- a generated configuration form for supported manifest setting fields;
- diagnostics with copyable bounded details;
- Enable/Disable, Reload for local sources, Check for updates/Update for managed sources, and Remove actions;
- a link to the Agents view to configure tool authorization.

The Agents view remains the policy surface. Its global and per-agent tool selectors group tools as Built-in, Custom HTTP, and by extension name. Unavailable tools remain visible with the reason and cannot be newly selected. Enabling an extension never enables its tools globally or adds them to agents. After a source first becomes Ready, the detail view offers a non-automatic “Configure tools” action.

Extension tools do not become slash commands and do not add navigation or panels. During a run, existing activity UI shows the tool's display name and an extension/source badge; failures link to the extension detail when a local source diagnostic is available. The slash menu continues to show skills only.

### 5. Render bounded extension configuration without extension UI code

The manifest may declare settings with stable keys and supported scalar controls: string, multiline string, number, boolean, and a fixed-choice select. A setting can be required, have a label/help text/default, and be marked secret. The app renders these controls; extensions cannot ship React or HTML for Settings.

Non-secret values live in Forage's device-local extension configuration. Secret values use the native credential store and are never written to `~/.forage/settings.json`, synchronized, shown after save, or included in diagnostics. Missing required settings produce Needs configuration and prevent the extension from being admitted to a run. Configuration changes apply to future runs.

The manifest's contribution and configuration declarations are descriptive, not a permissions sandbox. Once enabled, extension code has the user's local process permissions. The UI must state this plainly.

### 6. Adapt the native API to the local runtime

Implement a Forage extension host beside the sidecar. It loads only explicit admitted entry points, validates the default export and runtime registrations against `@forage/extension-api` contracts, and adapts registered tools and hooks to the embedded agent SDK. No Pi types or objects cross the extension boundary.

Filesystem/manifest inventory is distinct from executable validation: enumerate untrusted or disabled sources by reading manifests only; validate trusted enabled entries in a managed process that receives neither model credentials nor extension secrets. A source evaluation timeout and process boundary keep a hung extension from blocking Settings indefinitely.

For runs, pass consistent explicit host context, admitted extension revisions, and required configuration. Initialize supported hooks before model invocation. A trusted hook can perform arbitrary Node operations independently of model tool calls, so the UI must not imply that disabling a tool disables source code or hooks. Redirect conventional extension console output to stderr and reserve stdout for validated host messages.

### 7. Keep stable tool IDs and enforce policy everywhere

Use the manifest-declared tool ID as the portable Forage tool ID when it satisfies the existing lowercase identifier contract. Store extension ownership separately. Reserve built-in names, including `emit_outline`, and reject conflicts with custom HTTP tools. If two enabled sources provide the same tool ID, mark both contributions unavailable rather than choosing by load order.

Change settings hydration and save validation to preserve syntactically valid unknown tool IDs as unavailable placeholders. New selections must come from the current catalog. Admission intersects executor support, global enablement, agent selection, and run policy; required skill tools are a precondition rather than an additional grant. Recompute and verify that intersection inside the run host and expose only it, plus application-owned `emit_outline`, to the embedded SDK.

The catalog does not grant tool access. Do not automatically authorize newly discovered or newly installed tools. Preserve source provenance in local run metadata so an ID changing providers cannot silently reuse a previously admitted run.

### 8. Give management its own model-credential-free protocol

Add typed, request-correlated management messages for manifest inventory, validation, configuration status, source activation, install/update/remove, explicit update checks, and reload. Start management without model credentials; obtain model credentials only for a run process. Keep output and errors bounded and serialize package mutations.

Use a catalog revision containing installation IDs, extension IDs, resolved versions/commits or local entry digests, declared contributions, validated tool schemas, availability, and diagnostics. The webview receives validated data, never executable code.

Treat direct protocol writes by trusted Node code as outside the cooperative extension contract; validate every host message and result. Sanitize known credentials in logs/activity without claiming to prevent deliberately trusted code from reading or leaking data available to its process.

### 9. Make reload and package updates revision-aware

Keep the current per-run process/session model. At local admission, record a local extension snapshot containing catalog revision, source revisions, tool ownership, and configuration revision. This is executor-local metadata, not portable agent configuration or outline content. Managed revisions remain immutable while used by a run. For local development files, verify the recorded digest before loading and fail stale admissions rather than silently swapping implementations.

Reload rebuilds the catalog for future runs. In-flight sessions keep their loaded code. Propagate `AbortSignal` to tools, then terminate the run process after a bounded grace period if they do not cooperate. Disable/remove affects future runs; cancelling an active run remains explicit.

### 10. Use a Forage-owned package lifecycle

Accept npm package specifications, Git URLs with optional refs, and local directories. Locate and validate `forage.extension.json`; do not inspect Pi manifests or use Pi package-management APIs. Managed sources install under `~/.forage/packages/`; local directories are registrations and are never copied or deleted.

Install/update into staging, resolve dependencies with lifecycle scripts disabled, validate the manifest and entry, then atomically switch registration to the new immutable revision. Preserve the previous revision on error and retain revisions used by active runs. If a future extension requires dependency lifecycle scripts, that needs a separately designed warning and opt-in rather than silently expanding v1 trust.

Normal startup, discovery, refresh, and agent invocation use only installed resources and never contact a registry, clone a repository, install dependencies, or update code. “Check for updates” is explicit. Pinned npm versions and Git refs remain pinned until the user changes the requested source. Missing package-manager or Git prerequisites produce actionable diagnostics without damaging the last working revision.

### 11. Keep local execution authority explicit

The server remains unaware of desktop installation paths, code, secrets, configuration values, and trust. Portable agent configuration can retain extension tool IDs, but the server capability intersection rejects unavailable required tools and omits unsupported optional ones. No automatic local fallback or package installation follows synchronization.

During implementation, add an ADR superseding ADR-0007 only for explicitly trusted local extensions; retain bounded declarative built-ins and server policy. Update ADR-0013/current architecture so Pi is described as the internal agent engine behind the Forage extension host. Reconcile `Bounded and authorized tools` in the active `add-server-agent-executor` spec before either change is archived.

## Alternatives Considered

- **Expose Pi extensions directly:** fastest host integration, but it couples package authors and product UX to an internal dependency, inherits terminal/session concepts Forage does not support, and makes engine replacement a breaking ecosystem event.
- **Put extensions inside Agents settings:** keeps all tool controls together but obscures install/trust/configuration lifecycle and makes the already broad Agents view harder to understand.
- **Put extensions only under Advanced:** appropriate for diagnostics, but too hidden for a supported user capability.
- **Create a top-level extension browser:** useful if a marketplace exists later; excessive for local sources and explicit package specs in v1.
- **Allow extension-defined Settings UI:** flexible but turns a bounded agent extension API into an application plugin framework and greatly expands security, compatibility, and design-system surface.

## Risks / Trade-offs

- **Trusted Node code can access process resources** → Explain the boundary before activation, inspect manifests without code execution, keep management free of model credentials and extension secrets, and disable sources before import. The v1 API is not a sandbox.
- **A new API requires maintenance** → Keep it deliberately small, version manifest/API separately, provide contract tests, and adapt internally to the pinned engine.
- **Static declarations can drift from code** → Reject undeclared runtime contributions and diagnose missing declared contributions.
- **Extension code blocks or corrupts protocol output** → Use bounded validation/run processes, stderr logging, protocol validation, cancellation, and termination.
- **Two sources claim one tool ID** → Fail both contributions closed and surface provenance.
- **Local edits race with runs** → Record digests/revisions and reject stale admission.
- **Extensions become hard to find or confusing to authorize** → Use a dedicated Settings view, attention badges, contribution previews, and explicit links to the separate tool-policy surface.

## Migration Plan

1. Add native manifest/API/catalog contracts and both workspace projects, with no user sources active by default.
2. Implement manifest-only inventory and model-credential-free validation, then adapt validated registrations to the local engine and correct built-in tool authorization.
3. Add the Extensions Settings view, source detail/configuration, activation/reload, and grouped tool catalog. Existing agent/skill definitions retain their selections.
4. Add explicit Forage package lifecycle operations and failure-safe storage. Do not migrate or import existing Pi directories or packages.
5. Update policy documentation and reconcile the in-flight agent-execution spec, then validate desktop behavior and the packaged sidecar.

Rollback disables extension loading and management while retaining `.forage` registrations, configuration, and unavailable tool selections. No document schema migration or outline data rollback is required. Never delete external local source directories or alter Pi installations.

## References

Pi's registration ergonomics informed this design, but its format and API are deliberately not supported:

- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

Implementation of the runtime adapter must be checked against the repository's pinned embedded SDK. That adapter is private and does not define the extension contract.
