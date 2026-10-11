# Multi-pane workspace verification

## 1.x feasibility milestone — 2026-09-30

This milestone adds isolated prototypes, not production multi-pane routing. No outline format, persistence path, server contract, or production undo authority changes.

| Task | Evidence | Status |
| --- | --- | --- |
| 1.1 | `DocumentCoordinator.test.ts`: two mounted full-document ProseMirror views, stable ID preservation/assignment, one canonical normalization pass, one complete root/appended capture with `captureDocumentEvent`, identical resulting documents, and one projected compensating change | Complete |
| 1.2 | Coordinator tests cover inactive caret mapping/clamping without focus/scroll, safe stale text rebase, mismatched-revision recovery retaining input, deferred composition, composition replacement through multiple intervening commits, and conflicting input/DOM retention. `TwoViewPrototype.test.tsx` exercises DOM mutation, `compositionstart`/`compositionend`, another view's update, final convergence, and preserved focus | Complete (automated composition lifecycle evidence) |
| 1.3 | Self-verifying real Tauri/macOS run: AppKit drawable rectangles and outside-hit rejection, WKWebView viewport/responsive-layout inspection, independent DOM interactions/state, horizontal clipping, offscreen hiding, and restoration. Disabled-clipping and page-shrinking negative controls both fail as expected | Complete (native integration assertions) |
| 1.4 | ADR-0002 amendment, architecture map, AGENTS.md, and production editor comment distinguish one canonical document from multiple full-document view adapters and explicitly retain the bans on per-node documents and competing persistence/undo authority | Complete |

### Commands and results

- `pnpm install --frozen-lockfile` — passed; checkout initially had no dependencies installed.
- `pnpm --filter forage-sidecar build` — passed; generates the resource required by Tauri's build script.
- `./node_modules/.bin/vitest run apps/desktop/src/editor/prototypes apps/desktop/src/editor/eventCapture.test.ts apps/desktop/src/editor/persistentHistory.test.ts apps/desktop/src/application/OutlineSession.test.ts` — **45 tests passed in 5 files** (10 new prototype tests).
- `./node_modules/.bin/tsc -p apps/desktop/tsconfig.json --noEmit` — passed after the final prototype changes.
- `pnpm --filter @forage/desktop build` — passed. Existing Rollup annotation, mixed dynamic/static import, and chunk-size warnings were non-fatal. The development prototype is excluded from the production bundle.
- `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --example pane_clipping --offline` — passed.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --offline` — **46 native tests passed**.
- `pnpm --filter @forage/desktop test:pane-clipping` — **passed: 6 native integration stages and 2 negative controls**. Builds the example, launches each isolated native process, verifies its JSON report and exit status, and exits automatically.
- `rustfmt --edition 2021 --check apps/desktop/src-tauri/examples/pane_clipping.rs` and `node --check apps/desktop/scripts/verify-pane-clipping.mjs` — passed.
- `openspec validate add-multi-pane-workspace --strict` — passed.

The native integration harness ran in dedicated Herdr pane `w1V:p7`, without changing terminal focus. It uses AppKit and WebKit APIs inside its own disposable Tauri process, not desktop automation, accessibility, screen capture, or a browser application. The earlier UI inspection attempt was replaced with these assertions at the user's request. All processes exit automatically; the earlier temporary bundled probe was stopped.

```text
PASS normal (6 native integration stages)
PASS disabled-clipping (detected: Native ancestor does not clip)
PASS page-shrunk-to-sliver (detected: Native page shrank to its visible sliver)
PANE_CLIPPING_INTEGRATION_PASSED
```

Actual native-run measurements are saved in [native-clipping-report.json](native-clipping-report.json):

| Stage | Page A drawable x/width | Page B drawable x/width | WebKit viewports/layout |
| --- | --- | --- | --- |
| Opposite halves | 0 / 300px | 300 / 300px | Both 600px; two 300px columns |
| Scroll and narrow sliver | 480 / 120px | 150 / 300px | Both retain 600px/two columns |
| A offscreen | Empty drawable rectangle | 0 / 300px | Both retain 600px/two columns |
| Restored | 0 / 300px | 300 / 300px | Both retain 600px/two columns |

For each page at every geometry stage, the test verifies AppKit's clipping ancestor, actual full page frame, actual ancestor-clipped `visibleRect`, and rejection of four hits immediately outside the left/right/top/bottom boundaries. Visible containers also accept an in-pane hit. Responsive CSS would change layout below 400px, so checking both `innerWidth` and computed columns verifies that clipping does not cause narrow-page reflow. Counter activation and a document mutation in WebKit verify that one page's live state does not affect the other.

Negative controls mutate the actual native objects: disable `clipsToBounds` or resize the page to its visible width. Both produce the expected report error and nonzero process status. This caught a harness problem where macOS returned status 0 despite a requested Tauri failure exit; failures now terminate explicitly after writing their report. Each evaluation has a timeout, the native verification has a 30-second deadline, and the CLI harness has a process timeout.

This is native containment/layout/state evidence, not pixel screenshots or a synthesized operating-system mouse click. Workspace-shell integration, real external navigation, compositing under app overlays, and keyboard/focus routing remain later tasks.

### Reproduce the prototypes

**Document views:** start the desktop development frontend using the repository's Herdr runtime policy, then load `#two-view-prototype` in a development Tauri main webview. This development-only surface uses a disposable document and does not create an `OutlineSession` or load the user's outline. Both views can edit that full document. The header reports canonical revision and captured changes. A recoverable conflict shows the retained pending input. Browser use is optional and requires explicit user authorization under the repository instructions.

**Native automated test:** build the sidecar resource (`pnpm --filter forage-sidecar build`) and run `pnpm --filter @forage/desktop test:pane-clipping` using the repository's Herdr runtime policy. Cargo dependencies must be cached because the harness builds offline. This runs the positive native test and both negative controls. Set `FORAGE_PANE_PROBE_REPORT` to an output file to retain the successful run's JSON evidence. The temporary per-process reports are cleaned up automatically.

**Interactive fixture (optional):** `cargo run --example pane_clipping --offline` from `apps/desktop/src-tauri` leaves the isolated native fixture window open. Add `-- --verify` to run its native assertions and exit instead. No Forage plugins, registered application commands, persistence session, credentials, or network content are loaded. Two local HTML fixtures have responsive grids and independent counters, with a native 80px gap, 110px left margin, and space above/below. Each page retains a 600px layout inside a 300px native clip.

### Integration constraints and remaining checks

- `EditorState.apply` invokes `applyTransaction`; using it alone does **not** suppress normalization. Prototype view adapters clone plugin specifications without admission/append hooks. Production integration must deliberately separate document plugins from pane-local plugins and TipTap editor-bound closures rather than blindly reuse this prototype plugin arrangement.
- Stale edits rebase using inverse local mappings, intervening canonical mappings, and mirrored reapplied local steps. Failed mapping returns the original transaction for explicit recovery. Conflicting composing views retain their document/DOM and buffer instead of refreshing over typed input.
- The development composition adapter waits for ProseMirror's final DOM flush and avoids committing while another composition is active. Automated DOM lifecycle coverage is not an observation of an operating-system IME in WKWebView. A real IME smoke check remains part of native integration verification before shipping.
- Mapping/step retention is unbounded in this short-lived prototype. Production work must choose bounded retention/recovery and preserve all relevant programmatic metadata.
- The compensating-transaction test proves one coordinator capture/projection, not integrated durable undo/session lifecycle. Production `OutlineSession`, shared durable history, typing-group boundaries, remote changes, and agent/run lifetime remain 2.x tasks.
- Native clipping is macOS-only and intentionally isolated. Resource registry, geometry coalescing, pane hide/show/teardown, remote-page isolation, focus/shortcut forwarding, and actual workspace shell behavior remain later tasks. The native clip must own its full lifecycle; Tauri must not subsequently resize the page to the visible sliver.
- Full root tests, integrated native flows, server reconnect, restart, and performance checks remain 6.x; no later task has been marked complete by these checks.

## 2.x canonical production coordination — 2026-09-30

The existing single-pane shell now uses the production `editor/DocumentCoordinator.ts`. App owns its detached canonical TipTap editor, the existing OutlineSession, one transaction capture callback, and one durable history index. OutlinerEditor creates and destroys only its view adapter. All adapters share the exact canonical schema; normalization and document append hooks run exclusively in the canonical editor. No persistence format or server protocol changes were required.

| Task | Evidence | Status |
| --- | --- | --- |
| 2.1 | Full root suite passes, including existing App persistence/replay, normalization, durable history, and OutlineSession tests. Production coordinator tests verify one root/appended capture and stable IDs across two actual TipTap adapters | Complete |
| 2.2 | Production tests verify independent selection mapping, zoom/navigation stacks, search/filter state, context preview, DOM focus, and retained DOM scroll offsets. Persisted collapse, agent activity, and streaming decorations remain shared, including in newly mounted views | Complete |
| 2.3 | Production tests cover structural insertion with one normalization batch, mark commands using canonical schema types, one image asset reference in each view, atomic trash/restore, external paste normalization, internal clipboard provenance, and remote updates without recapture | Complete |
| 2.4 | Cross-pane typing groups and shared undo/redo tests replay finalized events. OutlineSession integration persists two edits plus undo/redo as exactly four events, closes the source view, then opens a fresh session and restores the identical document and ordered shared history without extra compensation events | Complete |
| 2.5 | Production tests complete stable-target writes after source teardown. The real skill-execution service test closes the pane during admission, continues streaming, moves the remaining pane's caret, and verifies final placement under the original stable ID without cancellation. Composition is committed on teardown or retained for explicit recovery | Complete |

### Commands and results

- `pnpm test` — passed, including extension/sidecar suites and **941 root tests in 131 files**; **30 tests / 1 file skipped**, including PostgreSQL contracts requiring their dedicated database.
- `pnpm exec vitest run apps/desktop/src/application/OutlineSession.test.ts apps/desktop/src/editor/DocumentCoordinator.test.ts apps/desktop/src/agent/skillExecution.test.ts --reporter=dot` — **42 tests passed**.
- `pnpm exec vitest run apps/desktop/src/editor/OutlinerEditor.test.tsx --reporter=dot` — **1 production React composition/lifecycle test passed**.
- `pnpm exec vitest run apps/desktop/src/agent/insertIntoEditor.test.ts --reporter=dot` — **32 tests passed**, including the legacy streaming entry point now resolving canonical ownership before asynchronous work.
- `pnpm --filter @forage/desktop build` — passed (strict TypeScript and production Vite build). Existing Rollup annotation, mixed import, and chunk-size warnings remain non-fatal.
- `git diff --check` — passed.
- `openspec validate add-multi-pane-workspace --strict` — passed.

The final full-suite/build runs required a network-enabled retry because sandboxed pnpm release-signature verification could not reach the registry. No Computer Use or browser was used. Native Rust code was unchanged by 2.x; the 1.x native test evidence above remains applicable.

### Production boundaries and remaining verification

- Each view owns editor-bound command contexts and UI plugins. Views exclude document append hooks; canonical projections use the adapter's native dispatcher for UI notifications and explicitly suppress event capture. Arbitrary transaction metadata survives stale-step rebasing.
- Canonical commit mappings are bounded to 256 revisions. Expired, rejected, or conflicting input remains in the coordinator recovery map and is surfaced through App's error UI; composing DOM is not overwritten. A closed composing pane attempts to commit its buffered input before detach.
- Clipboard provenance reaches canonical paste-rule closures, preserving internal marked clipboard content while external paste normalization runs once.
- Automated React tests exercise actual DOM mutation, composition events, the delayed ProseMirror flush, a concurrent canonical edit, convergence, preserved focus, and view teardown. These are jsdom assertions; operating-system IME behavior in WKWebView remains an integrated native verification task.
- DOM scroll-offset preservation is verified without layout. Independent visible scrollers and navigation scroll restoration belong to 3.x/4.x. The shell still exposes one outline pane; production coordinator tests mount multiple adapters directly.
- Asset tests verify shared content-addressed references and one image DOM node per view. Native asset bytes, PostgreSQL reconnect, complete workspace flow, native Page lifecycle, and large-outline performance remain later milestones.

## 3.x workspace state and navigation — 2026-09-30

`workspaceState.ts` and `WorkspaceController.ts` own session-local pane order, IDs, widths, typed outline/web locations, active/last-outline targeting, and visits with scroll offsets. App renders multiple full-document outline adapters through `OutlinePane.tsx`. Workspace navigation delegates to pane-local OutlinerUi state without changing document content or durable history.

| Task | Evidence | Status |
| --- | --- | --- |
| 3.1 | Six reducer tests cover insertion between existing panes, repeated targets, fresh split history with matching width/scroll, independent visits, close-neighbor choice, last-outline protection even with web entries, and last surviving outline targeting. Controller tests verify split/open produce no document changes or capture events | Complete |
| 3.2 | Actual TipTap click tests verify source pane/node identity, plain internal navigation intent, macOS Command-click and non-macOS Control-click open-right, plain HTTP opening, and preserved external-browser gestures. App tests verify insertion preserves the existing trail, repeated targets create new views, missing references report errors, and the source location stays unchanged on open-right. Node menus and hover previews retain their source | Complete |
| 3.3 | Controller tests verify independent Back/Forward with exact saved scroll offsets, live stable targets through rename/reparent, deletion/restore without redirecting to Home, and valid focus mapping. Production App tests show unavailable recovery controls and restore the same mounted view/target. Existing breadcrumb and navigation suites also pass | Complete |
| 3.4 | App tests verify one node menu and one Search dialog with multiple mounted views, and slash completion modifies the current pane's invocation while leaving the other unchanged. Overlays have distinct owner keys and become noninteractive outside their outline context; the global skill-run receiver remains installed once. Drag tests reject cross-pane targets and dispose an active owner's drag resources on teardown. Hover tests preserve a card when another pane closes and address opening to its original source | Complete |
| 3.5 | App derives the sidebar/Activity editor from the active or last-active surviving outline. Integration tests navigate from a web entry, preserve mounted outline identities across Settings/Tasks/Trash, retain visits/scroll on return, preserve focus when closing an inactive pane, and disable closing the final outline. OutlinePane replacement tests reset to one Home view, fresh history/scroll, and the new document while destroying old adapters. Visiting a web pane breaks the shared typing group | Complete |

### Commands and results

- `pnpm test` — an initial complete run passed **960 root tests**, before the last lifecycle/typing-group checks were added. Later concurrent runs hit timeouts in unchanged MCP settings/discovery tests, so final verification used serialized packages and bounded root workers.
- `pnpm test:extensions --concurrency=1` — **passed all 16 Turbo tasks**, including extension, MCP, shared runtime, and sidecar suites.
- `./node_modules/.bin/vitest run --reporter=dot --maxWorkers=2` — final **963 tests passed in 134 files**, with **30 tests / 1 file skipped** (environment-gated PostgreSQL contracts).
- `pnpm --filter @forage/desktop build` — final **passed**, including strict TypeScript and the production Vite build. Existing Rollup annotation, mixed import, and chunk-size warnings were non-fatal.
- `git diff --check` — passed.
- `openspec validate add-multi-pane-workspace --strict` — passed.

Sandboxed pnpm verification could not reach its release registry, and root WebSocket tests could not bind localhost (`EPERM`); the final package/build and root runs used the corresponding approved permissions. No browser, Computer Use, development runtime, or desktop automation was used. Native Rust code was unchanged by 3.x.

### Remaining milestones

- The basic horizontal pane presentation and independent outline scrollers support navigation now. Effective minimum widths, accessible resizing, focus reveal, aligned final headers/overflow, sidebar rails, shared pane command definitions, help, and native shortcut forwarding remain **4.x**. Current Split/Close controls are functional integration controls, not sign-off against the Pen layouts.
- Web entries retain URL/source provenance and workspace Reader visits/scroll. Until **5.x** replaces the singleton native Page bridge, only the active web entry mounts LinkPeekPane; inactive web entries show their URL focus control. Settings/Tasks/Trash unmount that active preview. Concurrent live Reader/Page surfaces, resource isolation, snapshots/cancellation, Page history/scroll restoration, and native clipping remain 5.x. The existing native Page capability has not been generalized by this milestone.
- Loaded-outline replacement creates a new workspace rather than persisting layout. Pane state never enters outline events, synchronization, or portable settings. Existing durable document/session/agent authority remains unchanged.
- DOM/focus/scroll assertions use jsdom. Native keyboard/IME flows, complete multi-web flows, server offline/reconnect, and large-outline performance remain **6.x**; no later tasks were marked complete by these checks.

## 4.x — Shell, commands, and native focus

Implemented the horizontal strip with independent vertical scrollers, a 360px default minimum, and a one-pane-width fallback for narrower content viewports. Dividers are visually 1px with a 9px pointer target, pointer capture, and focusable ARIA separators. Arrow keys resize adjacent panes by 10px (Shift: 50px), clamped to their effective bounds; size announcements use measured rendered widths. Explicit activation reveals the pane, including reactivation after manual horizontal scrolling. Document/background and vertical-scroll updates do not reveal it.

Outline and web headers align at 48px with raised-paper background and a soft bottom border. Location text truncates before controls. Pane actions expose the shared commands; web Reload/Copy/Open in browser use secondary overflow, with Reader/Page moved there when the header is exceptionally narrow. Native Page surfaces step aside for menus/dialogs and return focus to the app. Expanded navigation and Activity each own their collapse control; collapsed 56px rails retain an accessible expand button. Existing sidebar shortcuts remain unchanged.

`workspace/paneCommands.json` is consumed by TypeScript and Rust, with the specified provisional bindings: Command-Shift-Enter, Command-Shift-Backslash, Command-Option-Left/Right, and Command-W (Control/Alt outside macOS). Menus, tooltips, and keyboard help derive from this registry. Open-right prioritizes the caret's link, then current bullet, and reports availability by context. The one App dispatcher consumes handled DOM keys before editor shortcuts, respects form/menu/modal/IME ownership, and protects final-outline Close. Native messages snapshot the source pane so delayed delivery cannot target a different pane. A stale HTML activeElement does not override genuine native Page focus; the native Page's own input predicate and application overlays still own precedence.

The macOS event monitor consumes pane bindings before menu-bar window handling and forwards exactly one action from the native responder tree. It is enabled only for the outline workspace and limited to the owning application window. Repeated keydown is ignored. Native marked text and Page form/menu/modal predicates block pane actions; remote content receives no privileged command bridge. Dispatch is deferred out of the AppKit monitor to avoid reentering Wry's registry. This deadlock was caught and corrected by the native probe. The existing trusted-webview boundary covers the bounded workspace focus/enable commands.

### Automated evidence (no Computer Use or browser automation)

- `./node_modules/.bin/vitest run --reporter=dot --maxWorkers=2` — **136 files passed, 1 skipped; 972 tests passed, 30 skipped**. Environment-gated PostgreSQL contracts remain skipped. The final focused rerun covers subsequent input/focus refinements.
- Final focused rerun: `./node_modules/.bin/vitest run apps/desktop/src/workspace apps/desktop/src/App.test.tsx apps/desktop/src/components/Outliner/LinkPeekPane.test.tsx --maxWorkers=2` — **7 files, 69 tests passed**.
- `WorkspaceStrip.test.tsx` checks reveal geometry, independent scroll updates, two/three-pane bounds, keyboard resizing, ARIA size values, and session-only visit preservation.
- `commands.test.ts` checks exact Mac and Control/Alt bindings, focused-link priority, current-node fallback, contextual availability, final-outline protection, form/modal/menu/IME ownership, and stale HTML focus with native Page ownership.
- `App.test.tsx` exercises exactly-once DOM/native command dispatch, safe final Close, inactive close, menu precedence, IME/form precedence, preserved global sidebar bindings, and independent rails while web entries remain open.
- `LinkPeekPane.test.tsx` checks compact header overflow and explicit Page focus after showing its native surface. Existing page-mode/Reader tests remain in the focused suite.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — **44 native unit/integration tests passed**, including exact bindings from the shared registry and existing persistence/transport/asset contracts.
- `pnpm --filter @forage/desktop build` — strict TypeScript and Vite pass. Existing chunk-size/import annotation warnings are non-fatal.
- `apps/desktop/src-tauri/examples/pane_shortcuts.rs` posts AppKit key events inside the Tauri process, with no Accessibility or screen-recording permission. **10 owned shortcut deliveries** (five from main, five from native Page), **native-form and held-key precedence**, and **four shipped-CSS layout cases** pass. The report is [native-shortcut-report.json](native-shortcut-report.json).
- Layout evidence uses the compiled desktop CSS in WKWebView, with outline/web header classes. At 1480px, two panes fill 940px as 470/470; three retain 360px each and overflow. With both rails collapsed at 832px, the viewport is 720px and three panes overflow. With expanded sidebars at 720px, each pane fits the 180px content viewport and additional panes overflow. All tested headers are 48px, all dividers 1px, web primary controls remain inside their header, and scrolling the first pane to 111 leaves others at zero. This checks dimensions and containment against `j6MIs`, `Lv3U2`, `U6GEmb`, `B3v8d9`, `LHer1`, and `MVl2N`; it is not pixel-screenshot sign-off.
- Repeat locally after building desktop/sidecar: `pnpm --filter @forage/desktop test:pane-shortcuts`. Under Herdr, run the native test in a dedicated pane per repository policy. The probe exits automatically and its wrapper validates every report stage.

### Scope retained for later milestones

At the end of 4.x, only the active web entry mounted the singleton native Page/Reader bridge. Per-resource native addressing, concurrently live web panes, clipping/geometry lifecycle, independent Page history, late request/resource cleanup, and Reader-link open-right remain **5.x**. Full OS-driven IME/end-to-end workflows, screenshot-level design review, server outage/restart flows, and performance measurements remain **6.x**. These checks exercise native shortcut delivery and shipped CSS directly without claiming complete multi-web integration.


## 5.x independent web resources — 2026-09-30

All workspace web panes remain mounted across focus and Settings/Tasks/Trash changes. Each owns Reader state, abortable requests, native browsing history, loading/error/recovery UI and snapshot URLs. Live Page navigation updates the workspace URL for Split without reloading an echoed address; Reader navigation invalidates old native responses. Splits keep their original stable source. Clip/Summarize resolve the canonical document, and deletion disables automatic placement with an explicit destination message.

`PageLease` registers addressed events before creating its opaque native resource, filters ID/generation, invalidates ownership immediately on disposal, cancels queued work, closes late-created viewers, and releases listeners/snapshot URLs. `PageRegistry` is owned by the main window, allocates unique native labels, rejects unknown/closed IDs, marks resources dead before removal, filters obsolete presentation sequences and suppresses callbacks/snapshots after close. The main-window command guard and local-only plugin capabilities remain the authority; remote resources gain no application permissions. Navigation, redirects and new windows accept only HTTP(S) without embedded credentials; mail and modifier opening use the external handler.

Production macOS resources wrap each full-size WKWebView in a clipped NSView. Geometry carries both the full content rectangle and visible strip intersection, and handles logical/native coordinates at the actual window scale. A shared invalidation scheduler coalesces resize, scroll, layout/transition and overlay changes with no idle frame loop. Native resize/scale notifications invalidate geometry. Hidden/offscreen surfaces retain identity; overlays hide native input immediately without waiting for snapshots. Visibility filtering ignores hidden formatting menus and includes actual link hover cards. Native focus/shortcuts derive pane/resource ownership from the responder tree, and asynchronous application commands validate that ownership again.

| Task | Evidence | Status |
| --- | --- | --- |
| 5.1 | Lease tests address each command/state event; Rust registry tests isolate unknown/closed IDs and allocate fresh labels. The production native probe independently loads, follows links, goes Back/Forward and reloads two resources; closed/unknown operations fail while the other page remains intact | Complete |
| 5.2 | React tests retain mode/content/resources across focus and secondary views; discard Reader completions after navigation/close; release listeners and snapshot URLs. Lease tests cancel pending creation/commands and stale snapshots/events. Native probe verifies both registry and actual WKWebView removal after close | Complete |
| 5.3 | Coalesced geometry tests verify full rectangle vs strip intersection, shared scroll invalidation and no idle frame loop. Production native probe verifies partial clipping, horizontal movement, offscreen hiding, sidebar offsets, overlay/secondary-view hiding, restoration and full-width resizing on a 2× window. AppKit visibleRect/hitTest reject adjacent/header/footer input without shrinking the WK viewport | Complete |
| 5.4 | Reader tests cover same-pane navigation, explicit link-context Open in right pane, browser modifier escape and mail handling. Live events publish the current URL exactly once for Split and cannot retarget Reader navigation. Canonical two-view test changes focus, clips and summarizes under the original source, then deletes it and verifies disabled placement with an explanation. Existing workspace split tests preserve source/location | Complete |
| 5.5 | Scoped viewer failure/retry tests leave the second resource usable; Reader/browser recovery remains available. URL unit tests reject privileged schemes/credentials. The native production probe attempts both app commands and plugin-store access from remote HTTP content and verifies denial, then rejects forbidden navigation | Complete |

### Commands and results

- `./node_modules/.bin/vitest run --reporter=dot` — **984 tests passed, 30 skipped; 137 files passed, 1 skipped** before the final hidden-overlay assertion. Environment-gated PostgreSQL contracts remain skipped. Final `./node_modules/.bin/vitest run --maxWorkers=2 --reporter=dot`: **985 passed, 30 skipped; 137 files passed, 1 skipped**, including that assertion. The later focus-cancellation refinement is covered by the final web rerun.
- `./node_modules/.bin/vitest run apps/desktop/src/App.test.tsx apps/desktop/src/components/Outliner/LinkPeekPane.test.tsx apps/desktop/src/components/Outliner/pagePeek.test.ts apps/desktop/src/editor/readerDocument.test.ts --maxWorkers=2 --reporter=dot` — **63 tests passed in four files**. Earlier focused runs exposed existing App startup/persistence timing sensitivity; the retry case passed independently and in the full root run. App fixtures now settle startup inside React act and mock Reader transport, avoiding unrelated real Reader requests from concurrently mounted panes.
- Final `./node_modules/.bin/vitest run apps/desktop/src/components/Outliner/LinkPeekPane.test.tsx apps/desktop/src/components/Outliner/pagePeek.test.ts --reporter=dot` — **17 web/bridge tests passed**, including cancellation of native focus when creation finishes after the user activates another pane. Focus is requested only after an uncancelled presentation; background geometry never queues focus.
- `cargo test --offline` in `apps/desktop/src-tauri` — **45 tests passed** across native unit, SQLite, transport and asset suites.
- `pnpm --filter @forage/desktop build` — strict TypeScript and Vite pass; existing chunk/import warnings remain non-fatal. pnpm signature verification required a network-enabled retry after the sandboxed registry check failed.
- `FORAGE_RESOURCE_REPORT=openspec/changes/add-multi-pane-workspace/native-resource-report.json node apps/desktop/scripts/verify-pane-resources.mjs` — **13 production native checks passed**; evidence: [native-resource-report.json](native-resource-report.json).
- `FORAGE_SHORTCUT_REPORT=openspec/changes/add-multi-pane-workspace/native-shortcut-report.json node apps/desktop/scripts/verify-pane-shortcuts.mjs` — existing native shortcut/form/repeat and production-CSS checks pass using a registry-created resource instead of a singleton fixture; evidence: [native-shortcut-report.json](native-shortcut-report.json).
- `openspec validate add-multi-pane-workspace --strict`, strict desktop typecheck and `git diff --check` — passed.
- Repeat resources locally: `pnpm --filter @forage/desktop test:pane-resources`. Both self-verifying Tauri probes ran in a dedicated Herdr pane and exited automatically. No browser, Computer Use, Accessibility or screen-recording access was used.

These probes inspect production native commands and WKWebView/AppKit behavior with self-contained fixtures; supplied geometry exercises scroll/sidebar/overlay states rather than automating the full App. Full integrated three-pane workflows, OS IME, server reconnect/restart, cross-display changes and performance/resource measurements remain 6.x. Unsupported platforms offer Reader/browser recovery rather than an unclipped Page surface.


## 6.x integrated verification — 2026-09-30

All 6.x tasks are complete. The verification build mounts the actual React App with its production coordinator, pane shell, Page bridge, privileged command handler, SQLite repository, and durable local agent admission/result lifecycle. Its separate Vite entry and Rust example isolate fixture hooks from the shipped frontend. A fresh UUID-scoped application identifier and temporary SQLite/assets directory prevent access to normal Forage data. The wrapper launches two independent processes against the same test store, validates their reports, and removes only its own temporary data.

### Task evidence

| Task | Evidence and observed result | Status |
| --- | --- | --- |
| 6.1 | Required focused suites, full extension + root test command, desktop production build and Rust tests all pass; commands below | Complete |
| 6.2 | [Native App report](native-workspace-report.json): three actual outline adapters share edits; undo/redo compensate once; two live native webpages load; real AppKit Split/Close and previous/next focus address the correct pane; Settings hides both Page surfaces and retains their resource IDs; a 360px WK viewport clips to a 296px visible intersection after real strip/window changes; an admitted run finishes under its original invocation after its source pane closes | Complete |
| 6.3 | Native process restart retains all **45 unique document events**, shared edits and the completed run/result identity; layout resets to one Home outline and no web panes. Restart undo changes the text and appends exactly one compensation (**46 events**). `apps/server/src/workspaceSync.test.ts` runs the production OutlineSession/SyncEngine and server HTTP routes with three offline pane edits; reconnection rebases all three over a concurrent API capture, acknowledges revision 4, converges all views, invalidates obsolete history and leaves no pending outbox. A late server result after source-pane closure is projected and persisted once; a second sync produces no duplicates. Existing sync conflict/rebase and PostgreSQL contracts pass | Complete |
| 6.4 | Actual App benchmarks below cover **1/3/10 adapters and 1,004 bullets**, with full model/DOM counts and convergence checks. **20** outline open/close cycles destroy every closed editor; surviving adapters stay live. Five web/Settings/close cycles create **10** resources and leave **one main native webview**, zero Page resources and **zero snapshot object URLs** | Complete |
| 6.5 | [Workspace user guide](../../../docs/workspace.md), README feature description, architecture references and existing shared keyboard-help definitions describe shipped behavior, session-local layout and provisional bindings. Strict OpenSpec and diff checks pass. Every checked task in 1.x–6.x has evidence in this document and its linked reports | Complete |

### Commands and results

- `pnpm test --maxWorkers=3` — **238 extension/runtime tests** pass across eight packages (16 Turbo build/test tasks successful), followed by **988 root tests passed, 30 PostgreSQL tests skipped; 138 files passed, one skipped**. The dedicated PostgreSQL run below executes those skipped contracts. The unbounded first run exposed one jsdom caret ambiguity in the persistence-retry typing probe; its caret is now explicitly anchored before typing and the complete rerun passes.
- `./node_modules/.bin/vitest run apps/desktop/src/editor/DocumentCoordinator.test.ts apps/desktop/src/editor/OutlinerEditor.test.tsx apps/desktop/src/components/Outliner/LinkPeekPane.test.tsx apps/desktop/src/components/Outliner/pagePeek.test.ts apps/desktop/src/workspace apps/desktop/src/application/OutlineSession.test.ts apps/desktop/src/agent/skillExecution.test.ts apps/desktop/src/editor/outlineModel.test.ts --maxWorkers=3 --reporter=dot` — **130 focused tests passed in 12 files**.
- `TEST_DATABASE_URL=postgres://forage:forage@127.0.0.1:55437/forage_contract_test ./node_modules/.bin/vitest run apps/server/src/postgres.test.ts apps/server/src/workspaceSync.test.ts apps/desktop/src/sync/syncEngine.test.ts --maxWorkers=3 --reporter=dot` — **51 passed, no skips**, including all 30 PostgreSQL contracts. Only the dedicated `forage_contract_test` database was used for truncation. The worktree's test PostgreSQL container was stopped afterward.
- `pnpm --filter @forage/desktop build` — strict TypeScript and production Vite pass. Existing chunk/import annotation warnings remain non-fatal. `tsc -p apps/desktop/tsconfig.workspace-verify.json` and `tsc -p apps/server/tsconfig.json` also pass. The server test configuration includes DOM iterable types for the cross-boundary frontend integration fixture.
- `cargo test --offline` in `apps/desktop/src-tauri` — **45 native tests passed**, including SQLite, privileged transport and assets. The shared command-handler extraction preserves the production trusted-main guard and command table; it lets the fixture use the identical boundary.
- `FORAGE_WORKSPACE_REPORT="$PWD/openspec/changes/add-multi-pane-workspace/native-workspace-report.json" pnpm --filter @forage/desktop test:workspace-native` — **11 integrated flow stages plus SQLite restart passed**, including live AppKit keys, production WKWebViews and resource cleanup. The wrapper also requires median edit latency below 250ms and p95 below 500ms for each case, exactly 20 destroyed editors, one remaining native webview, no snapshot URLs, and identical durable event counts across restart.
- `openspec validate add-multi-pane-workspace --strict` and `git diff --check` — passed.

Native runs used a dedicated Herdr pane and exited automatically. No browser, Computer Use, Accessibility or screen-recording access was used. pnpm's signature check needed the permitted network-enabled retry when the sandbox could not reach the registry.

### Performance and fixes

The first actual-App measurement exposed a material regression: one/three/ten-pane median edit-to-frame latency was **89 / 450 / 1,783ms**, with a ten-pane p95 of **2,993ms**. The [baseline report](pane-performance-baseline.json) records those results. Three fixes retain the full-document architecture:

1. Bullet indexing now walks the immutable document once, without repeatedly resolving each position across sibling lists. A WeakMap cache reuses the index for the same document; a structural-move regression test verifies positions, hierarchy and invalidation.
2. Each view caches decorations for its current document/UI pair instead of rebuilding all controls for repeated ProseMirror requests. The detached canonical editor retains shared UI state without rendering unused controls.
3. The original measurement used `content-visibility: auto` for offscreen outline columns. The post-implementation regression below replaces this with explicit column intersection checks, while mounted adapters continue consuming every canonical update.

Milestone 6 measurements from the native report, before the rendering regression fix below (milliseconds):

| Panes | Bullets | Open/settle from one pane | Edit → frame median | Edit → frame p95 | View updates median | Editors / DOM items |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1004 | 30 | 36 | 41 | 4 | 1 / 1004 |
| 3 | 1004 | 518 | 60 | 86 | 16 | 3 / 3012 |
| 10 | 1004 | 2798 | 126 | 154 | 36 | 10 / 10040 |

Each case performs 12 insertions across the available panes and compares every view to the canonical document. The final probe explicitly focuses each source and settles focus for 30ms before timing; the initial probe rotated adapter mutations without that focus step, so the comparison is diagnostic rather than a controlled microbenchmark. Opening time includes a 30ms settle and creates additional views from one existing pane. Twenty open/close cycles took **8228ms**, with **20 destroyed editors**, **10 surviving adapters**, and zero snapshot URLs. WKWebView does not expose `performance.memory`; heap bytes are reported as `null`, while editor/DOM/native-resource lifetimes are measured directly. Timings are machine-specific release checks, not a universal throughput guarantee.

### Spec and design observations

The App checks cover shared-authority edits/undo, live splits, stable run destinations, safe closing, independent Page resources, adjacent focus, Settings round trips and native intersection clipping. Actual headers measure **48px**, separators **1px**, and the real window/strip contains full-width Page surfaces without overlap. The report links Pen references `j6MIs` (three-pane trail), `U6GEmb` (live split/menu), `Lv3U2` (horizontal trail), `B3v8d9` (web pane), and `LHer1`/`MVl2N` (56px sidebar rails); the earlier native shortcut report supplies rail, narrow-width and primary-control containment measurements. This is geometry/behavior verification, not pixel-screenshot sign-off.

The model transport is deterministic; actual local admission, streaming, result settlement, placement and SQLite durability run unchanged. Offline/reconnect uses an injected transport outage with real production server routes and an in-memory client/server repository; native SQLite restart and real PostgreSQL contracts are verified separately. These checks do not claim physical-IME interaction, cross-display hardware movement, external-site compatibility, or a live model-provider request. Existing automated composition/recovery, remote Page isolation and scoped failure tests remain part of the passing suites.

### Post-implementation pane regressions (2026-09-30)

The native fixture reproduced the source-pane blanking: the original editor and header remained connected with their document intact, but WebKit hit testing returned only the pane's outer section instead of its visible paragraph. Automatic `content-visibility: auto` was skipping its contents. The strip now checks pane intersections on insertion, explicit reveal, horizontal scroll and resize. Intersecting columns use explicit visible rendering; only wholly offscreen outline columns use `content-visibility: hidden`, retaining live adapters and shared authority. Scroll/focus reveal restores them before focus enters the editor.

Multi-pane flex items no longer shrink or grow to fit available space. They retain their assigned widths, with a 360px minimum even when the strip is narrower. A single pane fills its viewport and can fit below 360px. The close icon renders only for closable panes; the final outline remains protected in the command menu and keyboard dispatcher.

The [native regression report](native-workspace-regression-report.json) records **12 integrated stages plus restart**, including opening a bullet through its actual menu and opening a native Page. Both preserve the source paragraph in WebKit hit testing. Two panes remain **480px each** in both normal and **280px** strip widths; the lone surviving pane fits **280px**, and its close icon is absent. This adds no document events. The fixture activates panes through the production capture handler before focusing offscreen content and activates its native window before frame timing; the earlier background runs stalled on WebKit's suspended animation frames.

Updated 1/3/10-pane median edit-to-frame latency is **35 / 56 / 131ms**, with p95 **36 / 141 / 310ms**, passing the existing 250ms median and 500ms p95 gates. Twenty close cycles destroy all 20 temporary editors; one main native webview and zero snapshot URLs remain. SQLite restart retains 45 unique events, and durable undo appends the 46th.

Validation: **67 tests** passed across App, strip/controller/state/commands and production editor composition; **21 tests** passed across strip geometry and Page/Reader lifetimes. Strict verification TypeScript, the desktop production build, and `git diff --check` pass. Native tests ran in a dedicated Herdr pane without browser or Computer Use access.

### Centering and trailing-edge resize regressions (2026-09-30)

Pane groups now share spare horizontal space through equal outer auto margins. On overflow the margins become zero, keeping the first pane reachable at scroll offset zero. Multi-pane groups have a trailing resize handle as well as their internal dividers. The trailing handle changes only the final pane, enforces 360px, and supports the same 10px / Shift+50px keyboard adjustments. Pointer resizing accounts for changing centered margins so the edge follows the pointer. Keyboard increments use the assigned width immediately, including before ResizeObserver refreshes its measurements. A single pane continues to fill the strip without a resize handle.

The [final focused native report](native-workspace-layout-report.json) verifies the production App in WebKit: two 480px panes in a 1200px strip have equal **119px** margins; a **30px** outer drag produces a **540px** final pane and equal **89px** margins while keeping the source at 480px. Keyboard shrinking produces 490px; another 30px drag in an overflowing 700px strip produces 520px. Returning to scroll offset zero exposes the leading pane at exactly the strip's left edge. The source remains painted, narrow multi-pane widths remain intact, and the lone pane fits 280px.

`pnpm --filter @forage/desktop test:workspace-layout` builds and runs that bounded native regression without the foreground-dependent frame benchmark. Synthetic pointer events execute real production handlers against native WebKit layout; only pointer-capture methods are stubbed because synthetic streams cannot obtain browser-owned capture. This is not OS mouse automation. The dedicated Herdr pane and isolated fixture storage are cleaned up after completion.

**71 tests across five files**, the desktop production build, strict native fixture TypeScript/build, OpenSpec strict validation, and `git diff --check` pass. The [initial full native run](native-workspace-centering-report.json) also passed all 12 integrated stages, SQLite restart, cleanup and 1/3/10-pane performance gates (median **35 / 54 / 118ms**, p95 **39 / 68 / 302ms**). After the final keyboard measurement refinement, a full repeat passed layout checks but stalled during background WebKit animation-frame timing; the focused native command then passed against the final code. No browser or Computer Use was used.
