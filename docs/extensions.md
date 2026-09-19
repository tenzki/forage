# Extensions

Forage extensions add tools and lifecycle hooks to local agents through a native, versioned API. Pi inspires the code-first registration style, but Pi manifests, extension APIs, packages, and discovery rules are not supported.

## Settings workflow

Open Settings → Extensions to inventory installed and discovered sources. Inventory reads manifests only; it does not import code or contact npm/Git. The attention badge counts sources that need review or have a diagnostic.

**Install** accepts:

- an absolute or `~/.forage`-relative local directory;
- an npm package specification such as `npm:example-forage-tools@1.2.3`;
- an HTTPS or SSH Git URL with an optional ref.

Preview shows source/revision information, identity, compatibility, declared tools/hooks/settings, and diagnostics. npm and Git previews are explicit network operations. Registering a local directory leaves it in place; managed npm/Git revisions live under `~/.forage/packages/`. npm and Git executables must be available on `PATH` for their respective package operations. Dependency lifecycle scripts are disabled; a package that needs one is rejected.

Installation is not activation. Review the source details and trusted-code notice before **Review & enable**. Configuration is a separate app-rendered form, and model access is a third decision under Settings → Agents. A newly installed or enabled tool is never automatically globally enabled or selected for an agent.

Source actions are explicit:

- **Refresh** inventories only local state.
- **Reload** validates current local files for future runs.
- **Check for updates** is the only normal registry/remote check.
- **Update** stages and validates a managed revision before switching to it.
- **Disable** affects future runs; it does not cancel an active run.
- **Remove** unregisters a source. Forage deletes only managed package data after active leases end and never deletes an external local directory.

Unavailable tool selections remain visible in Agents so policy does not silently change when a package disappears. Restoring a source does not bypass current global, agent, or run authorization.

## Device data

Forage owns these paths:

```text
~/.forage/settings.json       versioned source/trust/settings configuration
~/.forage/extensions/        manifest-bearing drop-in directories
~/.forage/packages/          immutable managed npm/Git revisions
```

Writes to `settings.json` are serialized and atomic. Invalid configuration is preserved and diagnosed. Non-secret values are device-local. Secret values use scoped native credential references such as `forage-extension/<installation-id>/<setting-key>`; plaintext is not written to `settings.json`, synchronized, or included in diagnostics.

## Trust and execution limits

An enabled extension is trusted Node.js code, not declarative data and not sandboxed. It can use the local process's filesystem, network, and process permissions. Disabling one contributed tool prevents model dispatch to that tool, but source setup and declared lifecycle hooks can still run while the extension remains enabled.

Before a local run, Forage records the catalog, configuration, source, entry digest, ownership, and authorized tool IDs. The sidecar verifies that snapshot before importing code. Extension progress, logs, calls, results, and failures are bounded and carry installation/extension provenance. Cancellation reaches the tool's `AbortSignal`; the desktop terminates a run process that does not cooperate.

Extensions do not run in the webview and cannot supply Settings UI. Tool results follow the existing validated result and document-commit path; direct outline mutation is not part of the API. Local installations, trust, configuration, secrets, and snapshots never become portable server authority. Server-mode work does not fall back to a desktop extension.

For authoring, see the [public API contract](../packages/extension-api/README.md) and [reference extension](../packages/extensions/README.md).
