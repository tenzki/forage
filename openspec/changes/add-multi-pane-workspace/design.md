## Context

See `proposal.md` for motivation and scope. `App.tsx` currently owns one editor reference, one `linkPeek` request, and application-wide view navigation. Showing `LinkPeekPane` replaces the activity sidebar. `OutlinerUi` stores zoom, navigation stacks, query, and hide-completed state in the sole editor; collapse is a persisted node attribute. Internal-link events lack a source pane, while external-link events carry only a URL and source node.

`OutlinerEditor` captures a complete dispatch and its appended transactions for the existing event pipeline. `OutlineSession` owns persistence and synchronization orchestration; durable compensating events own undo. ADR-0002 and repository guidance require one canonical document and prohibit per-node editors or another authoritative outline tree.

The page bridge is also a singleton: `pagePeek.ts` has no pane argument and `page_peek.rs` uses one fixed webview label and one unaddressed state event. Native pages sit above the application webview, so CSS overflow alone cannot contain them.

## Goals / Non-Goals

**Goals:** independent, editable views over the same outline; explicit source and destination for navigation and mutations; one document commit path; native pages that remain contained during scrolling, resizing, overlays, and focus changes.

**Non-goals:** per-node documents, separate undo stacks, branching/copying outline content, collaborative cursors, vertical splits, tabs within panes, multiple application windows, cross-pane drag-and-drop, or persisted pane/session restoration. Settings, Tasks, and Trash remain application-level views. Existing ordinary outline drag/reorder behavior remains supported inside a pane.

## Design references

All IDs refer to the saved `docs/desktop.pen`, not application identifiers.

| Node | Reference |
| --- | --- |
| `pNJg9` | Original outline and link peek baseline |
| `XHhrd` | URL opening to the right |
| `qxzaw` | Internal node opening to the right and node menu |
| `j6MIs` | Three-pane horizontal trail |
| `U6GEmb` | Two live views of one node and pane menu |
| `Lv3U2` | Horizontal overflow with later panes visible |
| `B3v8d9` | Updated reusable web-pane header |
| `FOlXY`, `o61zDx`, `M3yfQm` | Shell and expanded/collapsed sidebar states |
| `LHer1`, `MVl2N` | Collapsed navigation and activity rails |

Use existing semantic colors and typography. Pane headers align at 48px with raised-paper background and a 1px soft bottom rule, without a colored top rule. Keep the visible divider 1px while providing a larger invisible pointer target and keyboard resize control. Outline pane horizontal padding is 20px. Node headers reuse breadcrumbs, history, pane actions, and Close; web headers retain URL, Reader/Page, history, reload, copy, external-open, pane actions, and Close. At narrow widths truncate location text first and move secondary actions into overflow before controls collide.

## Decisions

### 1. Model a workspace as ordered views, separate from content

Introduce a session-local workspace controller with stable pane IDs, an ordered pane list, active pane ID, and per-pane width/navigation/scroll state. Locations are typed outline roots (stable node ID or Home) or web URLs; web entries also retain their original outline source ID. Each pane has its own back/forward entries. A pane ID does not change during navigation.

Keep at least one outline pane. Close is disabled for the last outline pane even if web panes remain; closing another active pane focuses its left neighbor, or the right neighbor when none is left. Closing an inactive pane preserves focus. Split right creates a fresh pane at the same current location, with a fresh history and initially matching scroll position. It does not copy content, node IDs, or text selections; selection resolves to a valid location in the new view when focused.

Navigation from the global sidebar, search, backlinks, or activity targets the active outline pane, or the most recently active surviving outline pane when a web pane is active. Settings/Tasks/Trash hide the pane strip and all native page surfaces while retaining the outline session and pane state; returning restores them. Changing the loaded outline/storage context resets pane state to Home so IDs cannot leak across documents.

Alternative: extend the existing singleton peek flag or make panes outline nodes. Rejected because neither represents independent history/lifecycle and the latter would mix device UI with synchronized content.

### 2. Make open-right insertion deterministic

Every navigation request includes its source pane. Plain internal-link clicks navigate that pane. Command-click (Control-click on non-macOS) and Open in right pane insert a new target pane immediately after it, focus/reveal the new pane, and preserve every existing pane to its right. Plain HTTP(S) links in the outline do the same with a web pane. Reopening an already-visible target intentionally creates another view; it does not silently redirect to a different pane.

Within a web pane, ordinary webpage/Reader links keep browsing in that pane. Open in right pane on a Reader link explicitly adds another pane. Existing modifier-click on an external outline/Reader link continues opening the system browser, and mail links use the external handler. Arbitrary native webpage context menus need not gain Forage's node-specific commands. New-window webpage requests retain the existing supported policy and must never affect another pane.

Open-right on a missing internal target reports a broken link without adding an unusable pane. A target deleted after it was opened shows an unavailable state with Back/Home/Close; undo/restore resolves that same stable target again. Titles and breadcrumbs derive from current content, so rename or reparent updates all relevant headers.

Alternative: always reuse the next pane and discard its later trail. Rejected because explicit opening should not destroy working context.

### 3. Coordinate full-document views through one commit authority

Extract document transaction coordination from the single rendered editor before rendering multiple editable outline panes. There is one canonical full-document state/revision, normalization path, event capture subscriber, `OutlineSession`, and durable history index. Each outline pane presents the full document through its own view state and zoom decorations; it never loads a detached branch document or saves pane JSON back over the outline.

Use a canonical transaction coordinator with pane-local ProseMirror view states derived from the same committed document. A local view transaction is tagged with pane identity and base revision. The coordinator accepts it against the current revision, runs document-changing normalization/identity plugins once, captures the complete batch once, and projects the resulting steps into all views. Projection dispatches cannot capture events, run normalization again, invoke agents, or create history entries. Transactions against a stale revision must be mapped through retained mappings or rejected with a recoverable refresh; they cannot overwrite the canonical document. Never broadcast independent `setContent` calls as a synchronization strategy.

Selection, zoom, navigation history, query, hide-completed, menus, and scroll are per-pane. Map inactive selections/bookmarks through every document change; clamp deleted selections to a valid visible position without stealing focus or scrolling another pane. Existing persisted collapse attributes remain shared across views in this change. Shared run state and document decorations are projected consistently while transient context previews stay in the initiating pane.

Undo/redo from any outline pane uses the existing global durable history and broadcasts one compensating change. A pane switch ends the current typing group so typing in two panes does not accidentally merge into one undo unit. Programmatic edits, accepted server state, asset insertions, trash/restore, and agent output all enter the same coordinator. Failure/recovery remains application-wide. Pane close cannot cancel persistence or dispose the document session.

The first implementation milestone must prove two editable views, normalization-once, mapped selections, IME composition, and one durable undo path. Preserve composition by deferring projection into a composing view and mapping its pending edit at commit; if safe mapping fails, surface recovery without silently dropping text. Amend ADR-0002 and the single-mounted-editor guidance to distinguish one authoritative document from several full-document view adapters. The ban on per-node editors and competing history remains.

Alternatives: independent TipTap editors saving their own copies (divergent document/history), or a read-only second pane (does not meet live editing). Both are rejected. No CRDT or collaborative editing dependency is introduced for local views of one session.

### 4. Scope commands and agents to explicit origins

Add pane identity to internal/external navigation, node menus, search, drag, and toolbar actions instead of letting every mounted view consume a global event. Active-pane routing also covers formatting, slash menus, internal-link completion, and keyboard commands. Shared listeners and run observers are installed once; pane-local overlays render only for their owner.

An agent invocation snapshots its initiating node and normal branch/link context through the canonical document. Opening other panes does not implicitly expand that context. Accepted output targets stable IDs in that document even if focus changes or the initiating pane closes. Closing a pane only disposes view resources; explicit run cancellation remains in Activity. Web Clip/Summarize similarly retains its source node rather than using whichever caret is active later. If that source is missing, explain the unavailable destination and require an explicit new target rather than inserting elsewhere.

Alternative: infer the target from a global active editor at completion time. Rejected because asynchronous results could land in an unrelated branch.

### 5. Give each web pane an isolated native lifecycle

Thread an opaque pane/resource ID through every page bridge command and state event. Native code owns a registry scoped to the application window and validates IDs against created resources; webpage content cannot choose arbitrary webview labels. Each open web pane gets independent navigation/loading state, Reader requests, Page state, snapshot URLs, and cancellation. Late responses carry resource/navigation identity and are ignored after close or superseding navigation.

Create native resources lazily for Page mode, retain them while their pane is hidden or in Reader mode, and release them on close/window teardown. Hidden resources do not receive geometry updates. Remove the singleton warm-up or replace it with a correctly owned resource; never reuse one visible resource for different panes. Closing one pane must not blank another.

Bound the native surface to the intersection of its content rectangle and the horizontal workspace viewport, excluding headers, sidebars, and overlays. On macOS use a clipped native container so partial visibility preserves webpage layout rather than merely resizing the page to its visible sliver. Verify the platform integration early; CSS clipping of the application webview is insufficient. Fully offscreen, background-application-view, and overlay-occluded page surfaces are hidden as needed. Coalesce scroll/resize geometry updates, including window movement/scale changes, without flashing stale content over controls.

Preserve existing URL validation and remote-content capability restrictions. Keep application commands inaccessible to external pages. Native focus/shortcut forwarding must identify the owning pane and work when Page content has focus. Reader remains the fallback when native pages are unavailable; Page failures show a scoped error with Retry, Reader, and Open in browser.

Alternative: a remote iframe or a single shared native overlay. Rejected because the existing CSP excludes remote frames and a singleton cannot display independently navigable live pages side by side.

### 6. Horizontal overflow and independent sidebars

Use a horizontal scroll container between fixed navigation/activity sidebars. Start panes at equal useful widths when space permits, with a 360px default minimum per pane. On windows with less available width, let one pane fit the available content viewport; additional panes overflow horizontally. Resize adjacent panes through the divider, clamped to their effective minimum. Opening/focusing a pane reveals it; typing and background updates do not move the strip. Provide keyboard previous/next navigation and a visible horizontal scrollbar/overflow affordance.

Move collapse/expand buttons into the sidebars and keep compact rails when collapsed. Opening a web pane no longer substitutes for Activity or changes either sidebar's state. Pane overflow scrolls only the content strip. No pane drag-reordering is required in this change.

Alternative: compress every new pane or retain the peek-vs-activity conditional. Rejected because both break the approved expanding workspace.

### 7. Keep commands stable while shortcuts remain provisional

Use a single command registry for menus, tooltips, keyboard help, and native forwarding. Initial macOS bindings are:

| Command | Binding |
| --- | --- |
| Open focused link/node in right pane | Command-Shift-Enter |
| Split current pane right | Command-Shift-Backslash |
| Focus previous / next pane | Command-Option-Left / Right |
| Close active pane when closable | Command-W |
| Toggle navigation | Command-Backslash (existing) |
| Toggle activity | Command-Slash (existing) |

Use Control for Command and Alt for Option on other supported keyboard environments. Open-right prioritizes a focused link, then the current outline node; it is disabled where neither applies. Split right duplicates the pane's current location. Command-W is consumed within the workspace and does nothing destructive for the protected final outline pane; outside the workspace/modal context preserve the appropriate existing window/dialog behavior. Pane commands do not override form editing, menu navigation, IME composition, or established outline structural shortcuts. Prevent both native and web handlers from executing one keystroke twice.

Menus remain the primary discoverability path: node/link menu exposes Open in right pane; pane menu exposes Split right and Close pane with contextual availability. Exact glyph choices can be revisited without changing command semantics.

## Risks / Trade-offs

- **Multiple views duplicate event capture or stable IDs** → canonical coordination and duplicate-capture tests precede shell integration; verify replay and durable undo after cross-pane edits.
- **View projection corrupts selection or composition** → revision-tagged dispatch, mapped bookmarks, explicit composition coverage, and a recoverable stale-edit path.
- **Native pages cover adjacent UI or route to another pane** → validate clipping and two-page isolation in real Tauri before completing web integration; no browser-only sign-off.
- **Many panes consume memory** → dispose closed resources, suspend offscreen rendering/geometry work, and measure one/three/ten-pane cases on at least 1,000 bullets. Do not evict unsaved content or silently replace panes.
- **Active changes touch the same shell/editor paths** → compose with `redesign-settings` and agent changes without rewriting their authority or permissions; keep settings application-level.
- **Deferred restoration loses working layout on restart** → explicitly scope this release to session-local pane state; durable outline changes continue surviving restarts.

## Migration Plan

1. Prove canonical view coordination and native multi-page clipping with focused tests; amend architecture guidance before broad UI integration.
2. Route the existing single-pane experience through the coordinator with persistence, sync, undo, and agent regression checks. Initial workspace state is one Home outline pane.
3. Add multiple outline panes and source-aware commands, then pane-owned web resources, shell styling, and sidebar rails.
4. Verify native keyboard focus, multiple pages, narrow-window overflow, Settings round trips, source deletion, and close during agent execution. Record commands/results in a verification document during implementation.

There is no durable data migration: pane state is not written to outline events or portable settings. Rollback returns to the single-pane shell using the unchanged document/event formats. Architecture documents must describe whichever implementation actually ships.
