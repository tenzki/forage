# Proposal

## Why

Forage's built-in and declarative HTTP tools cannot cover custom integrations or workflows. Users need an extension model with the approachable registration style of Pi extensions, but Forage should own the format, API, compatibility policy, and application experience instead of exposing the embedded agent engine as a public dependency.

A native contract also lets Forage inspect an extension before running it, render extension configuration consistently, evolve the underlying agent runtime, and explain clearly where an installed capability appears in the app.

## What Changes

- Introduce a versioned `forage.extension.json` manifest and a Forage-native TypeScript API for registering tools and bounded local-agent lifecycle hooks. The API is inspired by Pi's register-and-subscribe style but is not Pi-compatible and does not expose Pi types or package conventions.
- Add `@forage/extension-api` as a small host-independent workspace package and `packages/extensions` as a dedicated first-party/reference extension project.
- Discover extensions in `~/.forage/extensions/`, explicitly registered local directories, and Forage-managed npm or Git packages. Installation, trust, enablement, configuration, and tool authorization remain distinct actions.
- Add an Extensions view to Settings with source inventory, status, manifest details, declared contributions, configuration, diagnostics, reload, and explicit package lifecycle controls.
- Add extension tools to the existing global and per-agent tool selectors, grouped by source and with unavailable state preserved. Extension tools are opt-in and do not become authorized merely because their source is installed or enabled.
- Adapt the Forage API to the embedded local agent runtime behind the sidecar boundary. Pi remains an internal implementation detail that can be replaced or upgraded without changing extension packages.
- Preserve structured outline output, cancellation, explicit context selection, and storage-mode execution authority.

## Capabilities

### New Capabilities

- `local-agent-extensions`: Trusted extension discovery, native API hosting, in-app management, dynamic tool authorization, diagnostics, reload, and local-executor behavior.
- `extension-packages`: Explicit installation and lifecycle management for packages using the Forage extension manifest.
- `extension-authoring`: A public extension API package, a dedicated reference extensions project, and a tested local development path.

### Modified Capabilities

None of the archived capability specs change. The active `add-server-agent-executor` change contains `agent-execution`, including a blanket restriction on arbitrary tools; implementation must reconcile that wording with the trusted local-extension exception while retaining server restrictions and execution authority. This proposal does not modify that change's files.

## Impact

- Desktop Settings, agent-definition validation, executor capability resolution, local run snapshots, and sidecar JSONL messages gain extension and catalog metadata.
- A model-credential-free management process inventories manifests, validates enabled extension code, manages packages, and reports diagnostics. A run process receives only admitted extension revisions and runtime configuration.
- `packages/extension-api` defines the public authoring contract without importing the embedded agent SDK. `packages/extensions` exercises that contract with a deterministic reference tool.
- ADR-0007's prohibition on executable plugins needs a documented local exception; ADR-0013 and architecture documentation need to describe the new trust boundary and runtime adapter accurately.
- Existing outline schemas and document persistence do not change. Installed code, source paths, trust decisions, and extension configuration remain device-local.

## Non-goals

Pi extension or package compatibility, importing resources from `~/.pi`, project-folder discovery tied to outlines, server execution of extensions, automatic installation from synchronized configuration, a marketplace, a standalone Forage CLI, arbitrary editor/UI plugins, extension-defined React components, imported slash commands or skills, and persistent agent sessions are outside this change.
