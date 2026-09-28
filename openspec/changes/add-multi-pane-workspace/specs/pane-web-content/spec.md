## Purpose

Provide independent webpage and reader panes that remain contained in the desktop workspace and preserve their original outline destinations for clipping and summarization.

## ADDED Requirements

### Requirement: Independent web pane state
Each web pane SHALL own its URL, navigation history, loading/error state, Reader/Page mode, and view resources. Actions and late responses for one pane SHALL NOT change another pane. Closing a pane SHALL release its resources without closing another page.

#### Scenario: Browse two pages
- **WHEN** two web panes are open and the user navigates, reloads, or changes mode in one
- **THEN** the other retains its URL, mode, history, and content

#### Scenario: Response arrives after close
- **WHEN** a page or reader request completes after its pane closes or navigates elsewhere
- **THEN** the stale response does not recreate that pane or replace another page's state

### Requirement: Web browsing and external opening
Ordinary links within Reader or live Page content SHALL navigate within their owning web pane. Reader links SHALL offer an explicit Open in right pane action. External modifier-click and Open in browser SHALL retain the existing external-browser behavior, and mail links SHALL use their external handler.

#### Scenario: Continue reading within a pane
- **WHEN** the user follows an ordinary article link inside a web pane
- **THEN** its history advances independently without creating another pane automatically

#### Scenario: Escape to the browser
- **WHEN** the user chooses Open in browser for a web pane
- **THEN** its current URL opens externally and the workspace remains intact

### Requirement: Contained native page surfaces
Native Page content SHALL be clipped to the visible intersection of its pane content area and the workspace viewport. It SHALL NOT cover headers, sidebars, adjacent panes, menus, dialogs, or application-level views. Offscreen or hidden page surfaces SHALL be hidden, and resizing or scrolling SHALL keep visible surfaces aligned without changing their browsing identity.

#### Scenario: Partially scroll a page out of view
- **WHEN** horizontal scrolling exposes only part of a Page pane
- **THEN** only that part of its content is visible and interactive, without covering its neighbor or reflowing the page to the clipped sliver

#### Scenario: Open Settings or an overlapping menu
- **WHEN** an application view or overlay covers a native page area
- **THEN** the native surface does not obscure or intercept input intended for that view or overlay

### Requirement: Pane-aware native focus and isolation
Application pane commands from focused native Page content SHALL target its owning pane and execute once. External pages SHALL retain existing URL restrictions and SHALL NOT gain application command or credential access.

#### Scenario: Close from a live page
- **WHEN** the user invokes the pane close shortcut while a live webpage has focus
- **THEN** only that owning pane closes and focus returns to the designated surviving pane

#### Scenario: Untrusted page requests application access
- **WHEN** remote page content attempts to invoke privileged application operations
- **THEN** existing native capability isolation denies that access regardless of how many panes are open

### Requirement: Source-bound clipping and summarization
Web panes SHALL retain the stable outline source of the opening action for Clip and Summarize. Changing focus, navigating within the web pane, or splitting that web view SHALL NOT substitute another outline destination. Missing destinations SHALL be explained and require an explicit valid target before placement.

#### Scenario: Clip while another branch is focused
- **WHEN** the user clips content from a web pane after focusing a different outline branch
- **THEN** the clip is placed under the original source through the canonical document mutation path

#### Scenario: Clip after deleting the source
- **WHEN** the original source node no longer exists
- **THEN** automatic placement is unavailable and the user receives a clear destination error instead of content being inserted elsewhere

### Requirement: Scoped failures and Reader fallback
Page or Reader failures SHALL remain scoped to their pane and provide retry/recovery actions. Reader SHALL remain available when native Page mode is unsupported; a Page failure SHALL offer Reader and external-browser recovery without affecting other panes.

#### Scenario: Native page cannot load
- **WHEN** Page mode fails in one web pane
- **THEN** that pane shows its error and recovery actions while other outline and web panes remain usable
