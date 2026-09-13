## ADDED Requirements

### Requirement: Server-originated agent output
The authoritative server SHALL append successful agent output as immutable outline events with explicit agent origin, actor, executor, run, skill, source, and change-group provenance. It SHALL assign those events contiguous revisions and update projections in the same locked transaction used for the terminal run result.

#### Scenario: Synchronize completed agent output
- **WHEN** a server worker completes a run with valid nested notes
- **THEN** it appends parent-first result events at the current outline revision and every device obtains the same output through ordinary ordered event pull

#### Scenario: Desktop is editing concurrently
- **WHEN** the authoritative outline advances while a run is executing
- **THEN** completion locks and applies against the latest server projection rather than overwriting or using stale last-writer-wins state

### Requirement: Canonical document authority and disposable indexes
Correctness-critical operations SHALL resolve stable node IDs from the canonical outline projection at the current outline revision. Flattened note projections SHALL be treated only as a disposable search index with versioned readiness and deterministic startup repair.

#### Scenario: Search index omits a live source
- **WHEN** a live canonical source node is absent from the flattened note index
- **THEN** agent admission and note placement still succeed, and reconciliation rebuilds the index without changing immutable events or requiring database truncation

### Requirement: Independent server readiness
The server SHALL report connection, outline synchronization, portable configuration, compute profile, worker, and note-index readiness independently. Outline synchronization readiness SHALL be sufficient for editing even when compute is unavailable.

#### Scenario: Connect without server compute
- **WHEN** outline and configuration provisioning are complete but the owner skips credential setup
- **THEN** editing and synchronization remain ready while agent admission reports the specific compute recovery action

### Requirement: Agent event compatibility negotiation
The server SHALL advertise support for agent-origin event versions and SHALL prevent worker output when a configured minimum client cannot safely interpret them. Clients SHALL reject unknown agent event versions without advancing acknowledged revision.

#### Scenario: Connected client is too old
- **WHEN** agent output would introduce an origin or event version below the server's minimum-compatible client boundary
- **THEN** the server keeps execution disabled or upgrade-required and appends no incompatible output

#### Scenario: Client receives an unknown agent event
- **WHEN** a client encounters an unsupported agent-origin event version during pull
- **THEN** it stops application, retains its prior acknowledged revision, and reports upgrade-required
