# Getting started with Forage

A new local installation opens guided setup after its outline and settings load successfully. Existing installations open their workspace as usual. To start or resume setup, open **Settings → General → Getting started**. Guided setup is local-only; it does not switch storage mode or enroll a server.

1. **Write a note.** Add details with Enter and Tab. Continue becomes available when the note is nonempty and its edits have been saved. The note is ordinary outline content, with the same editing and undo behavior as the workspace.
2. **Connect AI.** Add a supported provider account, save its default provider/model, and explicitly confirm that selection. You can skip AI and keep using the local outline without an account.
3. **Run a command.** Edit the `/brainstorm` request and choose Run command (or press Enter in its request field). The normal bounded note context is sent to the chosen provider. Its actual result appears in your outline and remains editable. Returning to this screen does not rerun it. A failed or interrupted command requires an explicit retry.
4. **Choose extensions.** Choices start unchecked. For an application-supplied source, review and register it, then make separate decisions about trust, configuration, global tools, assistant access, and optional skills. Image Generation uses its own OpenAI API key or local Codex login; connecting a model account does not verify image authentication. Skipping keeps already saved configuration and leaves pending choices unchanged.
5. **Connect MCP servers.** Find existing connections explicitly or add a named server by URL, launch command, or JSON configuration. Entry and resumption do not scan clients, connect endpoints, or launch commands. Connecting grants no new tool or assistant access; configure that later in **Settings → MCP servers**.

**Finish later** saves a paused setup that you resume explicitly from General settings. Closing the app during active setup restores its saved step on the next successful local startup. Setup rechecks saved references and asks for repair or skipping when a note, model, extension revision, or connection changed. Unfinished operations are never automatically repeated.

**Skip setup** opens the workspace. **Open Forage** acknowledges completion before opening it. Both keep your notes and saved configuration. Completed and explicitly skipped setup do not reopen automatically.

Setup progress is a separate, versioned device-local record. It contains identities and navigation state, not note text, credentials, model transcripts, commands, environment variables, headers, or copied tool permissions. A failed progress write leaves the previous acknowledged state and a retryable error.

## Automated native checks

Run `pnpm --filter @forage/desktop test:onboarding-native` on macOS. When `HERDR_ENV=1`, run it in a dedicated Herdr pane. The harness builds a separate verification frontend and launches an isolated Tauri process with disposable SQLite, settings, extension configuration, and fixture credentials. It never uses a browser or desktop automation.

The tests exercise the shipped React controls and CSS for screens 09A–09K at 960×760 and 480×600, checking centered content, hidden workspace chrome, scrolling, visible bottom navigation, and unchanged editor identity. A deliberately broken grid verifies that the layout assertions detect regressions. Native Enter submits the command once, and separate processes verify actual outline/run persistence, explicit paused resumption, automatic active resumption, and completed startup. Provider and model transports are deterministic fixtures; this is not a live provider sign-in or pixel screenshot approval.
