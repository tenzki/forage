# Extensions

Forage extensions add tools, lifecycle hooks, and optional generic skill executors through one current native API. Pi inspires the code-first registration style, but Pi manifests, extension APIs, packages, and discovery rules are not supported. The manifest has no API/manifest version discriminator; its `version` field is ordinary package release metadata.

## Settings workflow

Open Settings → Extensions to inventory installed and discovered sources. Inventory reads manifests only; it does not import code or contact npm/Git. The attention badge counts sources that need review or have a diagnostic.

**Install** accepts:

- an absolute or `~/.forage`-relative local directory;
- an npm package specification such as `npm:example-forage-tools@1.2.3`;
- an HTTPS or SSH Git URL with an optional ref.

Preview shows source/revision information, identity, declared tools/hooks/settings/executors, bounded executor forms, and diagnostics without importing code. npm and Git previews are explicit network operations. Registering a local directory leaves it in place; managed npm/Git revisions live under `~/.forage/packages/`. npm and Git executables must be available on `PATH` for their respective package operations. Dependency lifecycle scripts are disabled; a package that needs one is rejected.

Installation is not activation. Review the source details and trusted-code notice before **Review & enable**. Source configuration is separate, and tool authorization or explicit executor selection are further decisions. A newly installed extension never creates skills or commands; a tool is never automatically globally enabled or selected for an agent.

To use an executor, create or edit a normal skill under Settings → Agents and skills, select the extension contribution as its execution method, and complete the application-rendered fields. The skill's user-defined slash label remains the command. If the source is disabled or removed, the saved executor reference and non-secret configuration remain visible as unavailable; Forage does not substitute LLM execution or another extension.

Source actions are explicit:

- **Refresh** inventories only local state.
- **Reload** validates current local files for future runs.
- **Check for updates** is the only normal registry/remote check.
- **Update** stages and validates a managed revision before switching to it.
- **Disable** affects future runs; it does not cancel an active run.
- **Remove** unregisters a source. Forage deletes only managed package data after active leases end and never deletes an external local directory.

Unavailable tool and executor selections remain stored so policy and portable skill configuration do not silently change when a package disappears. Restoring a source does not bypass current trust, global, agent, or run authorization.

## Device data

Forage owns these paths:

```text
~/.forage/settings.json       versioned source/trust/settings configuration
~/.forage/extensions/        manifest-bearing drop-in directories
~/.forage/packages/          immutable managed npm/Git revisions
```

Writes to `settings.json` are serialized and atomic. Invalid configuration is preserved and diagnosed. Non-secret values are device-local. Secret values use scoped native credential references such as `forage-extension/<installation-id>/<setting-key>`; plaintext is not written to `settings.json`, synchronized, or included in diagnostics.

## Trust and execution limits

An enabled extension is trusted Node.js code, not declarative data and not sandboxed. It can use the local process's filesystem, network, and process permissions. Validation, preparation and direct execution use bounded child processes to protect the application protocol and lifecycle, but this is not an OS or network sandbox. Disabling one contributed tool prevents model dispatch to that tool, but source setup and declared lifecycle hooks can still run while the extension remains enabled.

Before a local run, Forage records the catalog, device-local configuration, source, entry digest, ownership and admitted contribution. Portable skill configuration and device-local extension configuration keep independent revisions. Generic executor validation/preparation receives no secrets or inference credentials; preparation can select only IDs in the immutable host context snapshot. The host pins the admitted plan and reference authority for execution. Direct execution receives only the selected extension's declared settings and scoped secrets; it does not start Pi, invoke unrelated hooks or receive LLM credentials. Extension progress, decoded logs, nested log data and failures are bounded and secret-sanitized without rewriting typed results. Cancellation reaches the contribution's `AbortSignal`; bounded process hosting terminates work that does not cooperate.

Extensions do not run in the webview and cannot supply Settings UI, commands or skills. Forage renders only supported declarative form controls. Tool and executor results follow validated application-owned document-commit paths; direct outline mutation is not part of the API. Local installations, trust, configuration, secrets, and snapshots never become portable server authority. Server-mode work does not fall back to a desktop extension.

Executor output is a static snapshot made from ordinary outline bullets and existing stable-ID links. It has normal edit, move, trash, persistence, synchronization, undo/redo, and completed-unplaced recovery behavior. Reopening output never reloads extension code, and Forage adds no live query, refresh control, or staleness state. A later invocation creates a separate result; it does not silently reevaluate an earlier one.

The System One package is an example of whole-feature ownership rather than a built-in Forage mode: its question models, candidate selection, Jev/TypeSafe requests, answer checks, sorting/filtering, and final labels all live in that extension. The desktop and shared runtime see the same generic executor envelope used by unrelated deterministic extensions.

For authoring, see the [public API contract](../packages/extension-api/README.md) and [reference extension](../extensions/reference/README.md).

Repository extensions live in `extensions/`: `reference/` is the deterministic example and `system-one/` owns the complete System One feature. Each is an independent workspace package with its own manifest, build, and tests. Shared extension infrastructure stays in `packages/extension-api` and `packages/extension-host`.

## Offline smoke coverage

The extension smoke is intentionally split at the real process and Tauri
boundaries so it never needs a paid provider or development database:

- `management-process.integration.test.ts` runs the packaged management entry
  through preview, local installation, trust/enablement, device configuration,
  reload, and removal while proving the external directory survives.
- `executor-process.integration.test.ts` runs the packaged executor and worker
  artifacts through source-pinned preparation and execution.
- `genericExtensionBoundary.integration.test.tsx` uses the deterministic
  non-evaluation reference executor through the application-rendered form,
  context preparation/preview plan, execution, stable links, cancellation,
  ordinary undo/redo, missing-extension behavior, server-unavailable gate, and
  the official Tauri IPC mock for retained-result restart/placement.
- the Rust event-store tests cover native durable restart and
  `completed_unplaced` migration, while a debug Tauri build verifies that the
  packaged shell contains and may spawn only the declared sidecar entries.

Run the normal extension suite and desktop tests, then build the real native
shell with `pnpm --filter @forage/desktop tauri build --debug --no-bundle`.
These checks use synthetic data and deterministic extensions only; they do not
contact TypeSafe, an LLM provider, npm/Git, or PostgreSQL.
