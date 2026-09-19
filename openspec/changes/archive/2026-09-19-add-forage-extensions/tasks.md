# Tasks

## 1. Native contracts and policy

- [x] 1.1 Define validated `forage.extension.json`, source, catalog, diagnostic, configuration, management-message, and local extension-snapshot contracts; verify versions, path confinement, bounded inputs, malformed messages, and separation from portable configuration.
- [x] 1.2 Define source/install identity, provenance, reserved tool IDs, valid contributions, and deterministic collision handling; verify duplicate extensions/providers, custom HTTP collisions, invalid IDs, and attempted `emit_outline` replacement.
- [x] 1.3 Define the v1 setup/tool/hook/result/progress/logging/cancellation API independently of the embedded SDK; verify public contracts contain no Pi, desktop, Tauri, React, or server types.
- [x] 1.4 Add an ADR for the trusted-local-extension exception and reconcile `Bounded and authorized tools` with the active or archived agent-execution spec; retain server restrictions, deny-by-default authorization, and execution authority.

## 2. Extension workspace projects

- [x] 2.1 Add private `packages/extension-api` (`@forage/extension-api`) with public types, `defineExtension`, contract tests, TypeScript configuration, and build/typecheck/test scripts.
- [x] 2.2 Add private `packages/extensions` (`@forage/extensions`) with a v1 Forage manifest, workspace API dependency, TypeScript configuration, and build/typecheck/test scripts.
- [x] 2.3 Implement the bounded deterministic `text_stats` reference extension; verify input validation, empty input, counting semantics, result shape, progress/cancellation, and bounds in Node tests without network/model calls.
- [x] 2.4 Integrate both projects into Turbo and normal repository testing without duplicate jsdom execution; verify filtered checks, `pnpm test:workspace`, and the Turbo build graph.

## 3. Manifest inventory and device configuration

- [x] 3.1 Implement versioned atomic `.forage` configuration storage, native secret references, source canonicalization, and serialized mutations; verify relative paths, duplicates, malformed-file preservation, secret exclusion, and concurrent changes.
- [x] 3.2 Inventory manifest-bearing directories and configured managed/local sources without importing disabled or untrusted entries; verify fixture side effects do not occur before activation and loose files/Pi-only packages are rejected.
- [x] 3.3 Validate manifest/API versions, path confinement, static contributions, setting declarations, and compatible entries; verify incompatible sources remain safely inspectable.
- [x] 3.4 Prove no ambient `.pi`, working-directory `.forage`, AGENTS, prompts, skills, or Pi package resolution enters inventory, the catalog, or a session.

## 4. Credential-free validation and runtime adapter

- [x] 4.1 Add request-correlated model-credential-free management support for inventory, validation, configuration status, activation, reload, and lifecycle operations; verify routing, cleanup, timeouts, concurrency, and absence of model credentials and extension secrets during entry validation.
- [x] 4.2 Implement the Forage extension host and adapt registered native tools/hooks to the pinned local agent engine without exposing engine objects; verify setup order and manifest/runtime agreement.
- [x] 4.3 Validate supported tool schemas, bounded text/JSON results, progress, structured logs, setting/secret access, `run:start`/`run:end`, and unsupported contributions.
- [x] 4.4 Fix sidecar built-in filtering and enforce the same effective allowlist for built-in, HTTP, and extension tools while retaining internal `emit_outline`; verify disabled tools cannot execute and missing required tools fail before a model call.
- [x] 4.5 Persist local source/tool/configuration provenance at admission and verify it at run start; test stale files, changed ownership, unavailable revisions, and deliberate retries against the current catalog.
- [x] 4.6 Apply reload to future runs while retaining active implementations; verify concurrent run/reload, source disable/remove, and configuration changes.
- [x] 4.7 Keep extension logs off stdout, validate/bound protocol output, sanitize known secrets, and report source/tool errors; verify console logging cannot corrupt JSONL and invalid results never reach document commit.
- [x] 4.8 Propagate cancellation and terminate unresponsive validation/run processes after a bounded grace period; verify cooperative abort, blocked execution, and rejection of late results.

## 5. Extensions Settings experience

- [x] 5.1 Add Extensions as a top-level Settings view with an attention count, trusted-code explanation, manifest-only inventory, status groups, Install, Open folder, and Refresh; verify discovery never opens a startup modal or performs network access.
- [x] 5.2 Add extension detail navigation showing identity, source/revision, compatibility, declared tools/hooks/settings, authorization summary, and bounded copyable diagnostics.
- [x] 5.3 Implement Review/Enable, Disable, Reload, Remove, and applicable update actions with explicit confirmation and busy/error states; verify installation and enablement remain separate.
- [x] 5.4 Render application-owned forms for supported manifest setting types and store secret/non-secret values through their correct boundaries; verify required configuration controls Ready state and no extension UI executes in the webview.
- [x] 5.5 Merge catalog tools into global and per-agent selectors grouped by Built-in, Custom HTTP, and extension source; retain unavailable references and verify new tools are never auto-authorized.
- [x] 5.6 Add Configure tools navigation from extension detail and show extension provenance in activity/failure UI without adding extension commands to the slash menu.
- [x] 5.7 Show local-only availability when server execution is authoritative; verify unsupported required tools fail admission without desktop fallback, package download, or trust changes.

## 6. Forage-owned package lifecycle

- [x] 6.1 Implement npm, Git/ref, and local-directory source parsing plus Forage manifest lookup without Pi package APIs; verify supported forms, explicit revisions, incompatible formats, and missing prerequisites.
- [x] 6.2 Add the Install flow with manifest/source preview and trust explanation; verify install/register does not enable the source, populate extension setting values, or authorize tools.
- [x] 6.3 Implement staged dependency installation with lifecycle scripts disabled, entry validation, and atomic registration; verify failed downloads, dependency resolution, script requirements, and invalid entries retain the last working revision.
- [x] 6.4 Implement explicit Check for updates and Update with pin preservation and active revision retention; verify no background registry/remote access, pinned sources stay fixed, and active runs retain prior code.
- [x] 6.5 Implement unregister/removal and managed-revision cleanup; verify external local paths remain untouched and configured tool references become unavailable rather than disappearing.
- [x] 6.6 Prove startup, inventory, refresh, validation, and invocation do not install/update missing resources; use subprocess/network spies and offline fixtures.

## 7. Documentation and end-to-end verification

- [x] 7.1 Write `packages/extension-api/README.md` covering the native API, manifest/version contract, supported contributions/results, configuration, trust boundary, and compatibility policy.
- [x] 7.2 Write `packages/extensions/README.md` covering the reference project, filtered commands, local registration/review/configure/reload loop, diagnostics, and local-only scope; verify every documented step.
- [x] 7.3 Add host integration tests that load the reference manifest/entry and exercise inventory, validation, authorization, hooks, settings, tool execution, activity, cancellation, and structured results with a fake model.
- [x] 7.4 Update architecture, development, Settings, and sidecar documentation to describe the native extension boundary, `.forage`, package prerequisites, trusted-code limits, and Pi as an internal adapter only.
- [x] 7.5 Exercise drop-in discovery, local edits, configuration, package install/update/removal, unavailable selections, activity provenance, and cancellation in the real Tauri app and packaged sidecar.
- [x] 7.6 Run targeted extension/policy/client/settings tests, `pnpm test:workspace`, `pnpm build`, and OpenSpec strict validation; record pre-existing failures separately and require acceptance evidence for all three capability specs.
