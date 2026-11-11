## Purpose

Record structural outline edits as steps proportional to the edit, so event size, history and rebasing do not grow with the outline.

## ADDED Requirements

### Requirement: Edit-sized structural steps
Indent, outdent, move, duplicate, trash and restore SHALL be applied as targeted document transforms in one transaction. Their recorded forward and inverse steps SHALL cover only the affected nodes and SHALL NOT replace the whole document.

#### Scenario: Indent one bullet in a large outline
- **WHEN** the user indents one bullet in an outline of several thousand bullets
- **THEN** the stored event's size depends on that bullet's subtree, not on the outline

#### Scenario: Undo a move
- **WHEN** the user undoes a move
- **THEN** the compensating event restores the previous position and leaves unrelated nodes untouched

### Requirement: Structural edits rebase
A structural edit SHALL rebase over a concurrent remote edit that touches a different part of the outline.

#### Scenario: Remote text edit during a local move
- **WHEN** a pending local move is rebased over a remote text change in another branch
- **THEN** both changes are present after synchronization

### Requirement: Capture cost proportional to the change
Capturing a transaction SHALL NOT serialize or hash the whole document more than once, and consecutive events SHALL reuse the previous event's resulting hash as their starting hash.

#### Scenario: Typing
- **WHEN** the user types a character
- **THEN** capture computes at most one full-document hash

### Requirement: Stable identity through structural edits
Structural edits SHALL preserve the stable identifiers of moved nodes, and duplicated nodes SHALL receive new identifiers at the canonical commit boundary.

#### Scenario: Move with a linked child
- **WHEN** a bullet that other bullets link to is moved
- **THEN** the links still resolve to it
