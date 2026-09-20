# Reference Forage extension

This private workspace project is a runnable example of the native Forage extension format. Its deterministic `text_stats` tool counts text, while its non-evaluation `label_notes` skill executor demonstrates generic configuration, preparation and ordinary linked output. It makes no network or model calls.

## Verify it independently

From the repository root:

```bash
pnpm --filter @forage/extensions build
pnpm --filter @forage/extensions typecheck
pnpm --filter @forage/extensions test
```

These commands require only the installed workspace dependencies. They do not launch Tauri, contact a model, connect to PostgreSQL, or modify `~/.forage`. The repository-wide extension integration suite is `pnpm test:extensions`.

## Local authoring loop

1. Run `pnpm --filter @forage/extensions build`. The manifest deliberately points to `./dist/index.js`, the same built-JavaScript shape used by managed packages.
2. Start the local desktop with `pnpm dev:desktop`, open Settings → Extensions, choose **Install**, select **Local directory**, and enter the absolute path to this `extensions/reference` directory.
3. Choose **Preview source**, inspect the native manifest, contributions, compatibility, path, and trusted-code warning, then choose **Register source**. Registration references the directory; it does not copy or alter it and does not enable or authorize anything.
4. Open the source details and choose **Review & enable**, then explicitly confirm trust. Enabled extension code runs with the local sidecar's user permissions; this is not a sandbox.
5. Optionally change **Progress message** and save. Forage owns the form and stores this non-secret value in device-local extension configuration.
6. To try the tool, choose **Configure tools**. In Settings → Agents, enable **Text statistics** globally and select it for the agent that should use it. Enabling the extension alone never grants the tool to a model.
7. To try the executor, create a normal skill, select **Label matching notes — Text Stats**, set **Text to match**, and choose your own slash label. The conditional stable-ID separator appears only when **Include stable IDs** is selected. No skill or command is installed by the extension.
8. Invoke the skill under a branch containing a matching note. Preview and execution use the same pinned selection; the result is an ordinary bullet with an existing internal link and needs no model credential or network call.
9. Edit `src/index.ts`, rebuild the project, then choose **Reload** in extension details. New runs use the validated build; an active run retains its admitted revision. A run admitted before an unreviewed file change fails stale rather than silently changing code.
10. Inspect bounded diagnostics in the extension detail view if the manifest, entry, runtime registrations, setting values, or contribution IDs do not validate.

To exercise drop-in discovery instead, place a complete manifest-bearing directory under `~/.forage/extensions/<directory-name>/` and choose **Refresh**. Loose files, Pi manifests, working-directory `.forage` folders, `.pi`, AGENTS files, prompts, and skills are not extension discovery inputs.

## What to change when creating another extension

- Give `forage.extension.json` a stable reverse-DNS extension ID and semantic version.
- Use the single current manifest shape. `version` is package release metadata; there are no manifest/API version discriminator fields.
- Declare every tool, hook, setting, and optional generic skill executor statically; runtime registration must match semantically.
- Executor forms may use bounded text, multiline, number, boolean, choice, object/repeated-group fields and conditional branches. Extensions provide no executable webview UI.
- Configuration validation and preparation run without secrets. Preparation can select only IDs in the immutable host context snapshot; execution receives the admitted plan and may return ordinary text/internal-reference nodes.
- Use `defineExtension` from `@forage/extension-api`, bounded input schemas/results, structured logging, and the supplied cancellation signal.
- Rebuild before Reload when the manifest entry targets `dist`.

The supported API is documented in [`@forage/extension-api`](../../packages/extension-api/README.md). Pi package conventions and APIs are intentionally unsupported. Extensions cannot add application UI, editor behavior, navigation, slash commands, skills, or direct outline writes.

Local extension code, trust, secrets and source configuration are device-local. Portable skill executor references and non-secret configuration have an independent revision. A server-authoritative run reports a required local extension tool or executor as unavailable; Forage does not copy the package to the server or silently run it on the desktop.
