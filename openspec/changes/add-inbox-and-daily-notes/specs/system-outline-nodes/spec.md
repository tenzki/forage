## ADDED Requirements

### Requirement: Canonical system-node identity
Every outline SHALL contain exactly one live top-level Inbox node with the `inbox` system role and exactly one live top-level Daily Notes node with the `daily-notes` system role. System identity SHALL be stored independently of visible title, document position, and stable node ID.

#### Scenario: Initialize a new outline
- **WHEN** Forage creates a new outline
- **THEN** the outline contains one canonical Inbox and one canonical Daily Notes container with distinct stable node IDs

#### Scenario: Load an existing outline
- **WHEN** Forage loads a valid outline that predates system roles
- **THEN** it adds the missing canonical system nodes without altering or deleting existing user content

#### Scenario: Preserve a title collision
- **WHEN** an existing ordinary node is titled “Inbox” or “Daily Notes” but has no corresponding system role
- **THEN** Forage preserves it as an ordinary node and does not use title matching to assign system identity

### Requirement: Content-preserving invariant repair
Forage SHALL validate system-role uniqueness and hierarchy when loading or accepting a document and SHALL restore the canonical invariants without discarding user-authored content.

#### Scenario: Repair duplicate container roles
- **WHEN** more than one node carries the `inbox` or `daily-notes` role
- **THEN** Forage deterministically retains one canonical role holder and preserves duplicate nodes and their descendants as ordinary content

#### Scenario: Repair an orphaned daily note
- **WHEN** a node with the `daily-note` role is outside the canonical Daily Notes container
- **THEN** Forage moves it under that container while preserving its stable node ID, daily date, content, and descendants

#### Scenario: Repeat repair
- **WHEN** invariant repair runs again on an already repaired outline
- **THEN** it makes no additional document change

### Requirement: Protected system-node structure
Forage SHALL keep the canonical Inbox and Daily Notes containers application-managed: their titles, system roles, stable identities, and hierarchy cannot be changed, and they cannot be trashed, purged, moved, converted, or duplicated. Presentation state such as expansion remains user-controlled. A daily-note root SHALL likewise retain its managed title, date metadata, and direct-child relationship to Daily Notes and cannot be renamed, moved, reparented, indented, converted, duplicated, or arbitrarily replaced. Content beneath a protected node SHALL retain normal outline editing behavior except for the stable empty-direct-child boundary behavior specified below.

#### Scenario: Attempt to rename a protected node
- **WHEN** a user types in, cuts, or replaces the title of a canonical system container or daily-note root
- **THEN** Forage silently leaves its application-managed title and required metadata unchanged

#### Scenario: Attempt to remove a canonical container
- **WHEN** a user directly deletes, cuts, trashes, purges, or replaces the canonical Inbox or Daily Notes container
- **THEN** Forage silently leaves the container, its required role, and its subtree intact

#### Scenario: Trash a dated page
- **WHEN** a user explicitly invokes Move to Trash for a daily-note root
- **THEN** Forage moves the complete dated-page subtree to recoverable Trash while leaving both canonical containers intact

#### Scenario: Attempt to delete a dated page through editing
- **WHEN** a direct delete, cut, or replacement transaction would remove a daily-note root without the explicit Move to Trash action
- **THEN** Forage silently leaves the dated page, its metadata, and its subtree intact

#### Scenario: Attempt to break the required hierarchy
- **WHEN** a user indents, drags, or otherwise moves a system container below another node or moves a daily-note root outside Daily Notes
- **THEN** Forage rejects the structural change without moving unrelated content

#### Scenario: Process an Inbox item
- **WHEN** a user edits, nests, moves, links, or trashes an ordinary note beneath Inbox
- **THEN** the operation behaves like the same operation on an ordinary note elsewhere in the outline, except for the empty leaf direct-child keyboard behavior specified below

### Requirement: Stable empty-child keyboard behavior
Forage SHALL maintain one predictable editable location at an empty system parent without creating or lifting redundant empty children.

#### Scenario: Delete an empty leaf child
- **WHEN** the selection is in an empty leaf direct child of Inbox, Daily Notes, or a daily-note root and the user presses Backspace
- **THEN** Forage deletes that child and selects its system parent

#### Scenario: Create the editable child
- **WHEN** an empty system parent is selected and the user presses Enter
- **THEN** Forage creates and selects one ordinary direct child

#### Scenario: Press Enter again on the empty child
- **WHEN** the selected node is that empty direct child and the user presses Enter again
- **THEN** Forage leaves the document and selection unchanged

### Requirement: Permanent application-owned navigation
Forage SHALL always expose Inbox, Daily Notes, and Tasks as application-owned sidebar items and built-in command-menu actions. These items SHALL NOT be created, persisted, ordered, renamed, hidden, or removed through the user-shortcuts collection or its controls. Inbox and Daily Notes navigation SHALL resolve their destinations by system role at invocation time; Tasks SHALL open the derived all-tasks view.

#### Scenario: Open Inbox
- **WHEN** the user activates the built-in Inbox destination
- **THEN** Forage zooms to the canonical Inbox node and focuses its first ordinary child, creating one blank child only when Inbox has no children

#### Scenario: Have no user shortcuts
- **WHEN** a new or existing outline has no user-created shortcuts
- **THEN** the Inbox, Daily Notes, and Tasks items are still present in the sidebar

#### Scenario: Clear user shortcuts
- **WHEN** the user removes or clears all user-created shortcuts
- **THEN** the Inbox, Daily Notes, and Tasks items remain present and unchanged

#### Scenario: Collapse the sidebar
- **WHEN** the user collapses the sidebar
- **THEN** Inbox, Daily Notes, and Tasks remain represented according to the sidebar's collapsed navigation presentation

#### Scenario: Navigate after repair
- **WHEN** system-node repair changes which stable node is canonical
- **THEN** the next built-in navigation action resolves the current canonical node rather than a stale cached ID

#### Scenario: Open a built-in destination from the command menu
- **WHEN** the user activates Inbox, Daily Notes, or Tasks from the command menu
- **THEN** Forage opens the same destination and behavior as its corresponding sidebar item

#### Scenario: Show the current sidebar destination
- **WHEN** the user opens a built-in secondary view or zooms into Inbox, Daily Notes, or one of their descendants
- **THEN** only that built-in destination is marked current and Home is marked current only for the unzoomed outline

### Requirement: Derived all-tasks view
The Tasks view SHALL show every live outline node whose `bulletKind` is `todo`, regardless of nesting depth, parent branch, authorship, or completion state. The view SHALL exclude trashed nodes and SHALL NOT create or persist a Tasks container or copied task collection. The sidebar badge SHALL show the number of live incomplete task nodes.

#### Scenario: Show the task count
- **WHEN** tasks are created, converted, completed, reopened, moved, or trashed
- **THEN** the Tasks sidebar badge shows the current total of live incomplete task nodes

#### Scenario: Show tasks across the outline
- **WHEN** open and completed tasks exist at different nesting depths and beneath different branches, including Inbox or a daily note
- **THEN** Tasks shows every one of those live task nodes

#### Scenario: Exclude non-tasks and trash
- **WHEN** the outline contains ordinary bullets and trashed task nodes
- **THEN** Tasks excludes those nodes from the all-tasks view

#### Scenario: Preserve an ordinary Tasks title
- **WHEN** a user creates an ordinary node titled “Tasks”
- **THEN** Forage leaves it as ordinary content and does not use it as the source of the Tasks sidebar view

### Requirement: Task ordering and source identity
The Tasks view SHALL group open tasks before completed tasks and SHALL preserve document order within each group. Every displayed row SHALL retain the original task's stable node ID and current completion state.

#### Scenario: Order mixed task states
- **WHEN** open and completed tasks are interleaved in the outline
- **THEN** Tasks lists open tasks first and completed tasks second while retaining outline order within each group

#### Scenario: Open a task result
- **WHEN** the user activates a task in the Tasks view
- **THEN** Forage navigates to or zooms into the original node in its outline context rather than opening a copy

### Requirement: Live task actions
The Tasks view SHALL update from the live outline and SHALL apply supported row actions to the original task node through the normal editor command path.

#### Scenario: Toggle completion from Tasks
- **WHEN** the user completes or reopens a task from the Tasks view
- **THEN** Forage changes the original node and the action participates in normal undo, persistence, and synchronization behavior

#### Scenario: Change task membership
- **WHEN** a node is created, converted to or from a task, moved, trashed, restored, completed, reopened, undone, redone, loaded, or synchronized
- **THEN** the Tasks view reflects the resulting live outline without updating a separate persisted task collection

### Requirement: One daily note per selected local calendar date
When the user opens Daily Notes, Forage SHALL resolve the operating system's current local calendar date and focus exactly one direct child of Daily Notes whose persisted `dailyDate` equals that date in `YYYY-MM-DD` form. While the active zoom path is within the canonical Daily Notes branch, the managed daily-note title SHALL render a compact calendar picker immediately after its localized date text; choosing another date SHALL resolve and focus that date.

#### Scenario: Open Daily Notes today
- **WHEN** the user invokes Daily Notes
- **THEN** Forage creates or reuses today's dated child, zooms to it, and focuses its first ordinary child

#### Scenario: Choose a date that does not exist
- **WHEN** the user chooses a date from the calendar picker and no daily-note child exists for it
- **THEN** Forage creates one dated child under Daily Notes, zooms to it, and focuses a new ordinary blank child for journal input

#### Scenario: Choose an existing date
- **WHEN** the user chooses a date whose daily-note child already exists
- **THEN** Forage zooms to the existing node and focuses its first ordinary child without creating a duplicate

#### Scenario: Render the inline picker
- **WHEN** the user is navigating within the canonical Daily Notes branch
- **THEN** its managed localized title text is immediately followed by a calendar icon that changes the active date

#### Scenario: Render a dated page on Home
- **WHEN** a daily-note root is visible while the user is navigating Home rather than the Daily Notes branch
- **THEN** Forage does not render the calendar picker for that page

#### Scenario: Open Daily Notes after local midnight
- **WHEN** the local calendar date has changed since the previous invocation
- **THEN** Daily Notes resolves the new current date and leaves earlier daily notes unchanged

#### Scenario: Change time zone
- **WHEN** the operating system time zone changes after a daily note was created
- **THEN** the existing node retains its persisted daily date and a later Daily Notes invocation resolves using the then-current local date

### Requirement: Daily-note organization and presentation
Every `daily-note` node SHALL be a direct child of Daily Notes, SHALL have a unique persisted `dailyDate`, and SHALL use a user-facing date label derived from that date. Newly created daily-note nodes SHALL appear newest-first and SHALL not be created merely because the app starts or midnight passes.

#### Scenario: Create dates out of sequence
- **WHEN** a daily note is created for a date newer than existing daily-note children
- **THEN** it is placed before the older dated children without reordering ordinary non-daily content destructively

#### Scenario: Start the app on a new date
- **WHEN** Forage starts on a date for which no daily note exists and the user does not invoke Daily Notes or choose that date
- **THEN** Forage does not create an empty daily-note node

#### Scenario: Render in the current locale
- **WHEN** Forage displays a daily-note root
- **THEN** its user-facing label is formatted for the current locale while its identity remains the persisted `YYYY-MM-DD` value

#### Scenario: Restore a valid dated page
- **WHEN** the user restores a trashed daily-note subtree with a valid date and no live daily note has that date
- **THEN** Forage restores the complete subtree under the current canonical Daily Notes container

#### Scenario: Reject an invalid dated-page restore
- **WHEN** a trashed daily-note subtree has an invalid date, the canonical Daily Notes container is missing, or a live daily note already has that date
- **THEN** Forage rejects the restore and leaves the Trash entry intact

### Requirement: Metadata persistence and compatibility
System roles, daily dates, and stable node IDs SHALL survive supported editing, undo/redo, persistence, synchronization, and schema migration paths. A migration or downgrade SHALL NOT silently remove metadata when doing so could break routing.

#### Scenario: Save and reload system nodes
- **WHEN** an outline containing system and daily-note nodes is saved and reopened
- **THEN** the same nodes retain their roles, daily dates, stable IDs, and descendants

#### Scenario: Encounter an incompatible downgrade
- **WHEN** an older schema cannot preserve required system metadata
- **THEN** Forage refuses the destructive downgrade and leaves the newer persisted outline untouched
