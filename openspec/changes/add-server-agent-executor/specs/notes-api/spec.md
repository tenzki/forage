## MODIFIED Requirements

### Requirement: Server-generated note event
A successful create-note command SHALL cause the server to assign the note identity and append exactly one canonical `note.created` event within the same PostgreSQL transaction that updates the outline projection. If the created note resolves to canonical Inbox and matches published automation, that transaction SHALL also admit at most one run per resolved skill without waiting for execution; automation admission failure SHALL roll back the transaction rather than commit an untracked partial trigger.

#### Scenario: Observe a created note on a desktop
- **WHEN** an external application creates a note and a synchronized desktop later pulls the assigned revision
- **THEN** applying the `note.created` event inserts the same stable note ID, text, provenance, and parent into the desktop outline

#### Scenario: Admit eligible automation atomically
- **WHEN** an Inbox note and its matched automation runs pass validation
- **THEN** the note event, projection, idempotency record, and queued runs commit together before the server returns the create-note response

#### Scenario: Automation admission cannot be persisted
- **WHEN** an otherwise valid matched run cannot be inserted in the capture transaction
- **THEN** neither the note nor any trigger is committed and the caller receives a retry-safe error
