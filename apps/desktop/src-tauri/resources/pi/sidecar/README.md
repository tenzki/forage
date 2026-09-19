# Local agent sidecar

This resource is the privileged local execution adapter launched by the Tauri shell plugin. `index.ts` runs admitted agents and `management.ts` handles credential-free extension inventory, validation, configuration, and explicit package lifecycle requests. The build creates self-contained ESM entries under `dist/`, so packaged apps do not depend on pnpm symlinks or a runtime TypeScript loader. Both communicate with the desktop through bounded, request-correlated JSONL; stdout is reserved for protocol messages and extension console output is redirected to stderr.

The sidecar embeds the pinned Pi SDK as an internal model/tool-loop engine. Pi types, sessions, manifests, discovery, package management, skills, prompts, and extension APIs do not cross the Forage extension boundary. Native entries receive only `@forage/extension-api`; `extension-tools.ts` privately adapts validated tools to the engine.

## Extension process boundaries

- Management starts without model credentials and strips known model/extension-secret environment variables from validation workers.
- Inventory reads `forage.extension.json` only. It never imports disabled or untrusted entries and never installs or updates missing resources.
- Validation runs in a bounded child process. Setup receives no extension secret values.
- A run receives a local admission snapshot and only declared extension secrets required for that run. The host verifies source/configuration revisions before import.
- Built-in, custom HTTP, and extension tools pass through the same effective allowlist. `emit_outline` remains application-owned.
- Managed revision leases keep active code available across update/removal; release triggers safe cleanup.
- Cancellation propagates through `AbortSignal`; the desktop owns the final grace-period process termination.

Enabled extension code is trusted local code with the sidecar user's OS permissions. The process boundary protects the webview and protocol integrity, but it is not an OS sandbox.

## Development and packaging

Run sidecar checks from the repository root:

```bash
pnpm --filter forage-sidecar typecheck
pnpm --filter forage-sidecar test
pnpm test:extensions
```

The Tauri resource bundle includes the generated `dist` directory and its code-split chunks. `apps/desktop/src-tauri/capabilities/default.json` allows the desktop to spawn only `dist/index.mjs` or `dist/management.mjs`. Source tests still use `tsx`, but production does not. Use a real Tauri build—not Vite alone—to verify the capability and packaged-resource paths:

```bash
pnpm --filter @forage/desktop tauri build --debug --no-bundle
```

The sidecar protocol is device-local and is not the public server agent protocol.
