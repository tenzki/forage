# Desktop onboarding verification

The shipped flow uses the existing outline/session, skill execution, credentials, extension management, and MCP services. It offers setup only after a fresh local outline and settings hydrate successfully. Existing installations enter through General settings. Progress is acknowledged independently of document persistence and never carries note content, secrets, or copied permissions.

## Automated evidence

| Command | Result |
| --- | --- |
| `./node_modules/.bin/vitest run --exclude '**/.claude/**' --exclude apps/server/src/postgres.test.ts --reporter=dot --maxWorkers=2` | 159 files, 1,201 tests passed; PostgreSQL contracts excluded because this change does not alter server persistence. |
| `./node_modules/.bin/vitest run apps/desktop/src/App.test.tsx apps/desktop/src/workspace apps/desktop/src/onboarding apps/desktop/src/application/OutlineSession.test.ts apps/desktop/src/store/settingsStoreMigration.test.ts --exclude '**/.claude/**' --reporter=dot --maxWorkers=2` | Final run: 10 files, 116 tests passed, including manual setup with multiple panes. |
| Sidecar `management-process.integration.test.ts` | 3 tests passed, including built application sources copied to a disposable installation without repository paths or node_modules. All three preview/register; explicit Text Stats activation validates its isolated bundled entry. |
| `./node_modules/.bin/vitest run apps/desktop/src/onboarding --exclude '**/.claude/**' --reporter=dot --maxWorkers=2` | 2 files, 14 tests passed, including missing-note, revoked-credential, interrupted-run, changed-source, and changed-MCP resume repair without external work. A subsequent regression run adds preservation of multiple pane adapters during manual setup. |
| `pnpm --filter @forage/desktop build` | Desktop strict TypeScript and production Vite build passed. Existing chunk-size and dependency comment warnings remain. |
| `pnpm --filter @forage/desktop test:onboarding-native` | Native App layout and persistence checks passed. See [machine-readable report](native-onboarding-report.json). |
| `pnpm --filter @forage/desktop test:workspace-layout` | Existing native multipane layout/resize regression passed with 1,002 seeded bullets, source visibility, centered/overflow resizing, and narrow panes. |
| `openspec validate add-desktop-onboarding --strict --no-interactive` | Passed. |
| `git diff --check` | Passed. |

The initial broad sandbox run could not bind loopback ports. The broad rerun outside the sandbox passed. Native and focused DOM tests initially found reserved sidebar grid space and asynchronous test waits; the grid override and state-based waits resolved these. Resume reference tests exposed reconciliation racing the manual resume transition; reconciliation now waits for that transition to settle. The final multi-pane entry uses the chosen outline adapter and retains the remaining pane editors; navigation to Home is an ordinary recorded pane visit. One existing App save-retry test timed out while builds/native verification ran concurrently; the suite passed after those completed. The existing workspace verification frontend now waits for its not-offered fixture record through a promise before mounting, retaining its Safari 13 build target without top-level await.

## Native layout coverage

`verify/onboarding.tsx`, the `onboarding` Rust example, and `scripts/verify-onboarding.mjs` follow the multipane native verification pattern. A separate verification frontend renders the production `App`, controls, editor, and CSS in a real Tauri WKWebView. The Rust example drives its owned window and calls fixture assertions directly; it uses no browser or computer-use automation.

The harness checks screens 09A–09K: note, provider setup, confirmed provider, command, pending command, editable result, extension choices, extension configuration, MCP inventory, URL setup, command setup, and completion. Each is measured in 960×760 and 480×600 native windows (content heights reflect the native title bar). Assertions cover centered/adaptive content, hidden chrome, horizontal overflow, footer containment, scrollable content, and preservation of the editor instance. A deliberately broken grid must fail the assertions. Native Enter admits one run; a second submit while pending admits none. Output is edited through the real editor and saved through native SQLite.

Four isolated processes verify paused setup stays closed, explicit General resumption preserves the note/result, active setup resumes automatically after restart, and completed setup stays closed. Resume performs no inference, MCP discovery, or connection. Extension selection performs no registration; source preview/registration uses the actual management sidecar and remains untrusted with no new grants.

The native harness uses disposable SQLite/settings/extension roots and a unique application identifier. Provider authorization/model transports are deterministic fixtures, not paid requests or live account sign-ins. The retained JSON contains fixture content and references only.

## Design reconciliation and remaining manual checks

The extension skip is in the bottom navigation beside Configure selected, as agreed for Pen node `fEDLl`. Trust, configuration, global tools, and assistant grants remain separate explicit operations through the ordinary Settings controls; illustrative checked choices are not defaults. MCP follows extension setup, starts with saved inventory, and offers explicit discovery or URL/command/JSON entry. Detailed tool/assistant permissions remain in Settings. Completion describes actual saved state, including connected MCP servers with zero available tools/assistants.

Live provider authorization, paid inference, external MCP endpoints/launches, and multi-source external failures have not been exercised by this harness. Pixel comparison with `desktop.pen`, packaged-app visual approval, and complete keyboard-only sign-off remain manual checks under tasks 7.3–7.4. Native automated fixture coverage is evidence for layout and durable lifecycle behavior, not a claim that those live checks passed.

User instructions prohibit browser and GUI automation in this repository. No such tools were used. Existing provider/extension/MCP suites exercise their shared validation and permission boundaries; onboarding introduces no substitute client or automatic grants.
