## Purpose

Allow multiple editable views of the same outline while preserving stable identities, a single durable history, and reliable targeting of user and agent changes.

## ADDED Requirements

### Requirement: One authoritative outline across views
Every outline pane SHALL edit the same canonical document. A user change, including required normalization, SHALL be captured and persisted once regardless of the number of views. Other panes SHALL reflect the committed change without generating duplicate events, nodes, normalization, or agent invocations.

#### Scenario: Edit a node visible in two panes
- **WHEN** the user changes text or structure in one of two views of a node
- **THEN** both views reflect the change, stable identity is preserved, and only the originating complete change is captured for persistence

#### Scenario: Receive a remote or agent change
- **WHEN** an accepted remote change or agent result changes content visible in several panes
- **THEN** every affected view reflects the canonical result without persisting the projection again

### Requirement: Independent transient view state
Selection, focus, zoom, navigation, search, hide-completed filtering, and scroll SHALL be independent per pane. Document changes SHALL map retained selections into valid positions without stealing focus. Existing persisted node-collapse state SHALL remain shared. Stale edits SHALL be mapped safely or rejected recoverably without overwriting newer content or silently dropping typed input.

#### Scenario: Edit before another pane's selection
- **WHEN** one pane inserts content before the caret saved in another pane
- **THEN** the saved caret follows the corresponding document position and the inactive pane is not focused or scrolled automatically

#### Scenario: Compose text while another change arrives
- **WHEN** text composition is active and a canonical change affects its document
- **THEN** composition is preserved and safely reconciled at commit, or a recoverable conflict preserves the user's input instead of silently replacing it

#### Scenario: Filter only one pane
- **WHEN** the user searches or hides completed nodes in one outline pane
- **THEN** other panes retain their own search and filtering state

### Requirement: Shared durable undo and lifecycle
All panes SHALL use the existing document-wide durable undo/redo authority. Switching panes SHALL end the current typing group. Opening, navigating, resizing, focusing, or closing panes SHALL NOT create outline events or reset history, and closing a pane SHALL NOT tear down the document session.

#### Scenario: Undo from a different pane
- **WHEN** the user edits in one pane and invokes undo from another
- **THEN** the latest eligible document change is compensated once and every view reflects the result

#### Scenario: Distinct typing groups across panes
- **WHEN** the user types in one pane, switches to another, and types again
- **THEN** the two typing sequences remain separate undo groups even when close together in time

#### Scenario: Restart after cross-pane edits
- **WHEN** the application restarts after reporting cross-pane edits as saved
- **THEN** the existing event replay restores those edits and durable history, without requiring persisted pane layout

### Requirement: Explicit mutation and agent targets
Commands and asynchronous actions SHALL retain their originating pane/node context. Agent context SHALL continue to derive from invocation placement and explicit internal references, not from other open panes. Closing or navigating a pane SHALL NOT retarget accepted agent work or web clipping to the currently focused node.

#### Scenario: Move focus during a run
- **WHEN** the user invokes an agent in one branch and then edits another pane
- **THEN** the run uses its admitted context and places output at its original stable target according to existing run rules

#### Scenario: Keep unrelated open content out of context
- **WHEN** other branches and webpages are visible in neighboring panes during an invocation
- **THEN** those panes do not add content to the agent's context unless normal explicit-reference rules include it

#### Scenario: Original destination disappears
- **WHEN** an asynchronous action's destination no longer exists
- **THEN** the application uses its explicit missing-target/recovery behavior rather than inserting into another pane's current selection
