## 1. Establish document and native view boundaries

- [ ] 1.1 Build a focused two-view transaction-coordinator prototype; verify one normalized document change, stable IDs, one event capture, and identical resulting documents across both views.
- [ ] 1.2 Prove selection mapping, stale-transaction rejection/recovery, and IME composition during another view's update; verify typed input is preserved and focus does not jump.
- [ ] 1.3 Prove two independent native Page surfaces with partial horizontal clipping in real Tauri; verify neither surface covers neighboring UI or reflows to its visible sliver.
- [ ] 1.4 Amend ADR-0002, architecture documentation, and repository single-editor guidance to describe one canonical document with multiple full-document views; verify that per-node editors and competing persistence/undo authority remain explicitly prohibited.

## 2. Introduce canonical document coordination

- [ ] 2.1 Route the existing single-pane editor through the canonical coordinator and retain one OutlineSession/capture subscriber; verify existing persistence, normalization, replay, and durable-history tests pass.
- [ ] 2.2 Separate pane-local selection, zoom, history, search, filtering, scroll, and transient overlays from shared document/run state; verify independent view behavior while persisted collapse stays shared.
- [ ] 2.3 Project canonical transactions into mounted views without recapture or repeated normalization; verify structural edits, generated assets, deletion/restore, and remote updates appear once in every view.
- [ ] 2.4 Route undo/redo through the shared durable history and break typing groups on pane switches; verify cross-pane undo/redo and restart replay without duplicate compensating events.
- [ ] 2.5 Route agent and programmatic mutations through the coordinator independently of rendered-pane lifetime; verify closing the initiating pane preserves active runs, persistence, and stable result placement.

## 3. Add workspace state and navigation

- [ ] 3.1 Add typed session-local pane state with stable IDs, ordered insertion, active/last-outline targeting, widths, and per-pane history; verify reducer tests for insertion between existing panes, split, close, and final-outline protection.
- [ ] 3.2 Make internal/external link and node-menu events source-pane aware; verify plain internal navigation, modified internal open-right, plain URL open-right, and preserved external-browser gestures.
- [ ] 3.3 Implement independent Back/Forward and scroll restoration, live titles/breadcrumbs, and unavailable-target recovery; verify rename, move, delete, restore, and repeated opening of the same target.
- [ ] 3.4 Scope search, formatting, slash commands, internal-link completion, backlinks, drag/reorder, and contextual overlays to their owner; verify one action fires once and modifies the intended pane/node.
- [ ] 3.5 Route global sidebar/Activity navigation to the active or last-active outline pane; verify Settings/Tasks/Trash round trips preserve workspace state and loaded-outline changes reset it safely.

## 4. Implement the shell and commands

- [ ] 4.1 Build the horizontal strip, independent vertical scrollers, minimum widths, 1px separators with accessible resize targets, and focus reveal; verify two/three-pane layouts, keyboard resizing, and narrow-window overflow against the Pen references.
- [ ] 4.2 Implement aligned 48px outline/web headers, truncation, and secondary-action overflow; verify all primary location and pane controls remain usable at the effective minimum width.
- [ ] 4.3 Move sidebar collapse/expand controls into expanded sidebars and collapsed rails; verify both sidebars remain independent while web panes are open and their existing shortcuts still work.
- [ ] 4.4 Add shared command definitions for Open in right pane, Split right, previous/next focus, and Close, with menus, tooltips, and keyboard help; verify contextual availability and the agreed provisional bindings.
- [ ] 4.5 Integrate native focus and shortcut forwarding with command dispatch; verify exactly-once actions from outline and native Page focus, modal/form/IME precedence, and safe Command-W behavior.

## 5. Generalize web panes

- [ ] 5.1 Replace the singleton page bridge and native label with a window-owned pane/resource registry and addressed commands/events; verify two pages can navigate independently and unknown/closed resource IDs cannot affect another page.
- [ ] 5.2 Give each LinkPeekPane independent Reader/Page requests, navigation state, cancellation, snapshots, and cleanup; verify late responses are ignored after navigation/close and resource URLs/listeners are released.
- [ ] 5.3 Integrate clipped native containers and coalesced viewport geometry updates; verify partial/offscreen panes, horizontal scrolling, resizing, window scaling, sidebar changes, and overlapping menus/dialogs in Tauri.
- [ ] 5.4 Preserve in-pane web browsing, explicit Reader-link open-right, external-browser escape, and source-bound Clip/Summarize; verify original-source placement after focus changes, web splitting, and source deletion.
- [ ] 5.5 Preserve Page isolation and URL validation and implement scoped retry/Reader/browser recovery; verify an unavailable native viewer or failed page leaves all other panes usable and remote pages lack application capabilities.

## 6. Verify the integrated feature

- [ ] 6.1 Run focused desktop/editor/page-bridge suites, root `pnpm test`, `pnpm --filter @forage/desktop build`, and native `cargo test` under `apps/desktop/src-tauri`; record commands and results in this change's verification document.
- [ ] 6.2 Exercise a real Tauri flow combining three panes, same-node editing, undo, two webpages, keyboard-only control, clipping, Settings navigation, and close during a run; record observed results against the spec scenarios and Pen references.
- [ ] 6.3 Verify local save/restart and server offline/reconnect across edits from different panes; confirm event counts, projections, run placement, and existing conflict recovery remain correct.
- [ ] 6.4 Measure one/three/ten-pane cases with at least 1,000 bullets and repeated open/close cycles; record latency and resource counts and resolve material regressions or leaks before release.
- [ ] 6.5 Update keyboard/user documentation and architecture references to shipped behavior, including session-local layout and provisional shortcuts; run strict OpenSpec validation and verify every completed task has supporting evidence.
