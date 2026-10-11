# Workspace panes

Forage keeps one outline document and lets you view it in multiple panes. Editing a bullet in one pane updates every view of that bullet. Collapse state and durable undo/redo are shared; selection, zoom, search, navigation history, and scrolling belong to each pane. Switching panes starts a new typing group.

Open a bullet from its menu with **Open in right pane**, or use the modified internal-link gesture (Command-click on macOS, Control-click elsewhere). Plain internal links navigate their own pane. Plain webpage links open a web pane immediately to the right of their source. Opening another pane inserts it beside that source and keeps later panes in order. **Split right** copies the current location and scroll position into a new pane with fresh navigation history.

Each pane has Back, Forward, Split, and a location header. The close button appears only when the pane can close. Secondary actions move into the header menu when space is limited. Drag an internal divider to resize neighboring panes, or the group's right edge to resize only the last pane. Focus either handle and use Left/Right for 10-pixel adjustments, or Shift with an arrow for 50 pixels. Multiple panes retain their assigned widths with a 360-pixel minimum instead of shrinking to fit; a single pane fits even a narrower viewport. The group centers when it fits, and scrolls horizontally when it is wider than the viewport. Focusing a pane reveals it. Each pane scrolls vertically on its own.

The bindings below are provisional. **Mod** means Command on macOS and Control elsewhere. They also appear in keyboard help and pane menus.

| Action | Binding |
| --- | --- |
| Open current target in right pane | Mod+Shift+Enter |
| Split active pane right | Mod+Shift+\ |
| Focus previous / next pane | Mod+Alt+Left / Right |
| Close active pane | Mod+W |
| Shared undo / redo in an outline editor | Mod+Z / Mod+Shift+Z |
| Toggle navigation sidebar | Mod+\ |
| Toggle Activity sidebar | Mod+/ |
| Settings | Mod+, |
| Keyboard help | Mod+Shift+/ |

Pane commands respect text fields, menus, dialogs, and IME composition. They work from native Page focus too. The last outline pane cannot close, and Mod+W does not close the application window. Closing an inactive pane preserves focus. Closing a pane during an accepted agent run leaves the run active and keeps its result addressed to the original stable outline target.

Web panes have independent **Reader** and **Page** modes, navigation, loading, and recovery controls. Page uses an isolated native web surface; it retains the full pane width while partially visible in the strip. Reader links navigate within their pane; use their explicit open-right action for another pane. Modified external links and the browser action use your external browser. Clip and Summarize stay attached to the web pane's original outline source, even after focus or navigation changes. If that source is deleted, restore it or open the webpage from another source to choose a new destination.

The navigation and Activity sidebars collapse independently into rails. Sidebar and Activity navigation use the active outline pane, or the most recently active surviving outline pane when a web pane is active. Settings, Tasks, and Trash preserve the workspace while hiding it. Deleted outline destinations retain their stable location and expose recovery controls.

Pane order, widths, locations, visits, and scroll offsets last only for the current session. Restarting or loading another outline opens a fresh Home workspace. Document edits, assets, run results, and durable history remain saved; layout is never part of document events, server sync, or portable settings.

On macOS, `pnpm --filter @forage/desktop test:workspace-layout` verifies pane visibility, centering, outer-edge resizing, overflow and the single-pane layout in an isolated native App. The broader `test:workspace-native` command also checks persistence, resource cleanup and edit-to-frame performance; keep its window visible and active while it measures frames.
