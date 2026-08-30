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
Forage SHALL prevent user operations from trashing, purging, indenting, reparenting, changing the role of, or converting to a todo any canonical system container or daily-note root. Content beneath a protected node SHALL retain normal outline editing behavior.

#### Scenario: Attempt to remove a protected node
- **WHEN** a user invokes trash, purge, cut, or document replacement on a canonical system node
- **THEN** Forage leaves the protected node and its required role intact and provides non-destructive feedback

#### Scenario: Attempt to break the required hierarchy
- **WHEN** a user indents, drags, or otherwise moves a system container below another node or moves a daily-note root outside Daily Notes
- **THEN** Forage rejects the structural change without moving unrelated content

#### Scenario: Process an Inbox item
- **WHEN** a user edits, nests, moves, links, or trashes an ordinary note beneath Inbox
- **THEN** the operation behaves like the same operation on an ordinary note elsewhere in the outline

### Requirement: Permanent application-owned sidebar items
Forage SHALL always expose Inbox, Daily Notes, and Tasks as application-owned sidebar items. These items SHALL NOT be created, persisted, ordered, renamed, hidden, or removed through the user-shortcuts collection or its controls. Inbox and Daily Notes navigation SHALL resolve their destinations by system role at invocation time; Tasks SHALL open the derived all-tasks view.

#### Scenario: Open Inbox
- **WHEN** the user activates the built-in Inbox destination
- **THEN** Forage zooms to the canonical Inbox node

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

### Requirement: Derived all-tasks view
The Tasks sidebar item SHALL show every live outline node whose `bulletKind` is `todo`, regardless of nesting depth, parent branch, authorship, or completion state. The view SHALL exclude trashed nodes and SHALL NOT create or persist a Tasks container or copied task collection.

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

### Requirement: One daily note per local calendar date
When the user invokes Daily Notes, Forage SHALL resolve the operating system's current local calendar date and SHALL focus exactly one direct child of Daily Notes whose persisted `dailyDate` equals that date in `YYYY-MM-DD` form.

#### Scenario: Open Daily Notes for the first time today
- **WHEN** no daily-note child exists for the current local date and the user invokes Daily Notes
- **THEN** Forage creates one dated child under Daily Notes and zooms to it

#### Scenario: Reopen Daily Notes on the same day
- **WHEN** a daily-note child already exists for the current local date and the user invokes Daily Notes
- **THEN** Forage zooms to the existing node without creating another one

#### Scenario: Invoke Daily Notes after local midnight
- **WHEN** the local calendar date has changed since the previous invocation
- **THEN** Forage resolves or creates the node for the new date and leaves earlier daily notes unchanged

#### Scenario: Change time zone
- **WHEN** the operating system time zone changes after a daily note was created
- **THEN** the existing node retains its persisted daily date and a later invocation resolves using the then-current local date

### Requirement: Daily-note organization and presentation
Every `daily-note` node SHALL be a direct child of Daily Notes, SHALL have a unique persisted `dailyDate`, and SHALL use a user-facing date label derived from that date. Newly created daily-note nodes SHALL appear newest-first and SHALL not be created merely because the app starts or midnight passes.

#### Scenario: Create dates out of sequence
- **WHEN** a daily note is created for a date newer than existing daily-note children
- **THEN** it is placed before the older dated children without reordering ordinary non-daily content destructively

#### Scenario: Start the app on a new date
- **WHEN** Forage starts on a date for which no daily note exists and the user does not invoke Daily Notes
- **THEN** Forage does not create an empty daily-note node

#### Scenario: Render in the current locale
- **WHEN** Forage displays a daily-note root
- **THEN** its user-facing label is formatted for the current locale while its identity remains the persisted `YYYY-MM-DD` value

### Requirement: Metadata persistence and compatibility
System roles, daily dates, stable node IDs, and capture provenance SHALL survive supported editing, undo/redo, persistence, synchronization, and schema migration paths. A migration or downgrade SHALL NOT silently remove metadata when doing so could break routing or lose provenance.

#### Scenario: Save and reload system nodes
- **WHEN** an outline containing system and daily-note nodes is saved and reopened
- **THEN** the same nodes retain their roles, daily dates, stable IDs, and descendants

#### Scenario: Encounter an incompatible downgrade
- **WHEN** an older schema cannot preserve required system or provenance metadata
- **THEN** Forage refuses the destructive downgrade and leaves the newer persisted outline untouched
