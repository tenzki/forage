## Purpose

Let users keep outline branches and webpages side by side while navigating a horizontal workspace without losing their existing working context.

## ADDED Requirements

### Requirement: Ordered horizontal workspace
The desktop SHALL support multiple outline and web panes in an ordered horizontal strip with independent vertical scrolling, resizable widths, and horizontal overflow. Opening or focusing a pane SHALL reveal it without closing existing panes. Background updates SHALL NOT move the user's viewport.

#### Scenario: Open a third pane
- **WHEN** two panes already occupy the available content width and the user opens another
- **THEN** all three remain open, the new pane is revealed, and the strip scrolls horizontally rather than compressing panes below their effective minimum

#### Scenario: Resize using the keyboard
- **WHEN** the user focuses a pane separator and uses its resize controls
- **THEN** adjacent pane widths change within their bounds and the control exposes its current size accessibly

### Requirement: Source-aware link opening
Plain internal-link activation SHALL navigate the source outline pane. Command-click on macOS, or Control-click in other supported keyboard environments, SHALL open the internal target in a new pane immediately to the source pane's right. Plain HTTP(S) link activation in an outline SHALL open a web pane in the same position. Existing panes to the right SHALL be preserved.

#### Scenario: Follow an internal reference without leaving the source
- **WHEN** the user Command-clicks a valid internal link in the left pane
- **THEN** a new outline pane opens at that target to its right and the source location remains unchanged

#### Scenario: Preserve an existing trail
- **WHEN** the user opens a URL from a pane that already has neighbors to the right
- **THEN** a new web pane is inserted immediately after the source, receives focus, and the existing neighbors remain open in order

#### Scenario: Reject a broken reference
- **WHEN** the requested internal target does not exist
- **THEN** the application reports the broken reference without creating a new pane or navigating away from the current content

### Requirement: Live split and independent history
Split right SHALL open a new view of the current pane location with a fresh navigation history and initially matching scroll position. It SHALL NOT duplicate outline content. Each pane SHALL retain its own back/forward navigation and scroll state, independent of other panes.

#### Scenario: Split the current node
- **WHEN** the user selects Split right while viewing a node
- **THEN** a second view of that same stable node opens to the right without creating nodes or document events

#### Scenario: Navigate one view
- **WHEN** the user follows a link and then goes Back in one pane
- **THEN** that pane restores its prior location and scroll state without changing another pane's navigation

### Requirement: Discoverable pane commands
The system SHALL expose Open in right pane in node/link menus and Split right and Close pane in pane menus. It SHALL provide initial bindings of Command-Shift-Enter, Command-Shift-Backslash, Command-Option-Left/Right, and Command-W for open-right, split-right, previous/next focus, and close respectively, with Control/Alt equivalents outside macOS. Help and tooltips SHALL match the active bindings. Sidebar bindings SHALL remain Command-Backslash and Command-Slash.

#### Scenario: Open the focused target
- **WHEN** the user invokes open-right in an outline pane
- **THEN** the focused link is opened if present, otherwise the current node is opened, and the command is unavailable if neither exists

#### Scenario: Avoid keyboard conflicts
- **WHEN** a form, modal, menu, or IME composition owns keyboard input
- **THEN** pane commands respect that context and do not also execute as outline, native-window, or duplicate pane actions

### Requirement: Safe closing and focus
The workspace SHALL retain at least one outline pane. Closing another pane SHALL release only that pane's view resources. Closing the active pane SHALL focus the surviving left neighbor, or the right neighbor if no left neighbor exists; closing an inactive pane SHALL preserve the active pane.

#### Scenario: Close the last outline pane
- **WHEN** the user invokes Close on the sole remaining outline pane, including when web panes remain
- **THEN** Close is unavailable and the workspace and application window remain open

#### Scenario: Close during background work
- **WHEN** a pane associated with an active agent run is closed
- **THEN** the run and outline persistence continue and Activity remains available

### Requirement: Pane lifecycle and unavailable nodes
Pane titles and breadcrumbs SHALL follow current stable-node identity. Deleted targets SHALL show an unavailable state with recovery navigation rather than redirecting silently. Pane state SHALL survive application-level view switches within the session, reset when the loaded outline context changes, and remain outside document history and synchronization.

#### Scenario: Delete and restore a viewed node
- **WHEN** a node open in another pane is deleted and subsequently restored with the same identity
- **THEN** the other pane first shows its unavailable state and then resolves the restored node without creating a replacement node

#### Scenario: Return from Settings
- **WHEN** the user opens Settings and returns to the outline
- **THEN** the pane order, locations, widths, and scroll positions remain available without rebuilding the document session

### Requirement: Independent shell sidebars and aligned headers
Navigation and activity SHALL remain independent of pane content, with collapse and expand controls inside their expanded sidebars and collapsed rails. Web opening SHALL NOT replace Activity or change either sidebar's state. All pane headers SHALL align in height and border treatment and keep location and pane actions usable at narrow widths.

#### Scenario: Open a webpage with Activity visible
- **WHEN** a URL opens to the right while Activity is expanded
- **THEN** Activity stays expanded outside the pane strip and the user can independently collapse it

#### Scenario: Navigate globally while a web pane is active
- **WHEN** a sidebar, search, backlink, or Activity action targets an outline node while a web pane is active
- **THEN** the most recently active surviving outline pane receives the navigation and focus
