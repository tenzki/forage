## Why

Forage currently has one outline view and one replaceable link peek, so following references or comparing branches disrupts the user's working context. The pane explorations in `docs/desktop.pen` establish a horizontal workspace where nodes and webpages can remain open side by side.

## What Changes

- Introduce an ordered, resizable horizontal strip of outline and web panes, with independent navigation, scrolling, focus, and close actions. Additional panes extend the strip rather than squeezing every pane to fit.
- Open ordinary outline URL clicks and Command-clicked internal links immediately to the right of their source pane. Plain internal-link navigation stays in its source pane.
- Add Open in right pane and Split right actions to contextual/pane menus and keyboard commands. Split right opens another live view of the current location; it never duplicates outline content.
- Keep all outline views connected to one canonical document, event capture pipeline, durable undo history, and agent lifecycle. Make transient view state and command targeting pane-aware.
- Replace the singleton native page viewer with pane-addressed web resources, preserving Reader/Page modes, browser escape, clipping, summarization, and existing web-content isolation.
- Match the approved compact pane separators and aligned headers. Keep navigation and activity as independently collapsible sidebars with their controls inside the sidebars, including collapsed rails.
- Use the agreed shortcuts provisionally; preserve Command-Backslash and Command-Slash for the sidebars. Keep menu access independent of future shortcut changes.

## Capabilities

### New Capabilities

- `multi-pane-workspace`: Pane ordering, layout, navigation, link routing, menus, focus, shortcuts, and sidebar behavior.
- `shared-outline-views`: Editable views of one outline with separate view state, single event capture and undo authority, and stable agent/selection targeting.
- `pane-web-content`: Independent web pane lifecycle, Reader/Page behavior, native bounds and focus, and source-bound outline actions.

### Modified Capabilities

None. Existing storage, synchronization, agent, and asset requirements remain unchanged.

## Impact

- Desktop `App`, outline chrome/editor/plugins, link events, contextual menus, keyboard handling, sidebars, and workspace styles.
- A document/view coordination boundary alongside `OutlineSession`, with one persistence and synchronization subscription regardless of pane count. ADR-0002's single-mounted-editor implementation guidance must be amended while preserving its single-document and durable-history invariants.
- `LinkPeekPane`, `pagePeek.ts`, native `page_peek.rs`, and native shortcut/event routing require pane identities and lifecycle handling.
- No document schema, event format, server API, or backend execution change is intended. Pane layout is session-local in this first version; restoring it across application restarts is deferred.
- Focused document/interaction tests and real Tauri verification are required. The settings redesign remains a separate change; panes preserve its application-level navigation.
