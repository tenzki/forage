# Requirements: AI Chat

**Defined:** 2026-03-24
**Core Value:** The tree is the universal data structure — every note, conversation, and piece of generated content lives as a node, and an AI agent can operate on any branch using configurable skills.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Tree

- [x] **TREE-01**: User can create infinite nested bullet-point nodes
- [x] **TREE-02**: User can expand and collapse any branch
- [x] **TREE-03**: User can zoom/hoist into any node (node becomes root view with breadcrumb trail)
- [x] **TREE-04**: User can navigate and edit entirely via keyboard (Tab, Shift-Tab, Enter, Alt+Arrow, Delete)
- [x] **TREE-05**: User can search across all nodes with results navigable in context
- [x] **TREE-06**: User can drag nodes to reorder or re-nest them

### Editing

- [ ] **EDIT-01**: User can undo and redo structural and text operations
- [ ] **EDIT-02**: User can use inline Markdown formatting (bold, italic, code)
- [ ] **EDIT-03**: User can tag nodes with #hashtags parsed from content
- [ ] **EDIT-04**: AI-generated content is visually distinguished from user-written content

### Agent

- [ ] **AGNT-01**: User can trigger agent actions via slash commands (e.g., `/research topic`)
- [ ] **AGNT-02**: Agent generates structured child notes using branch context (ancestors + siblings)
- [ ] **AGNT-03**: Agent can generate inline content on the current node
- [ ] **AGNT-04**: User can create and configure custom skills (system prompt + model config)
- [ ] **AGNT-05**: At least one built-in skill (research) works out of the box

### Infrastructure

- [ ] **INFR-01**: User can store and manage their own LLM API keys (OpenAI, Anthropic)
- [x] **INFR-02**: Data persists locally across app restarts (local-first SQLite)
- [ ] **INFR-03**: Data syncs across devices via iCloud Drive
- [x] **INFR-04**: Data model supports node types to enable future chat mode

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Chat

- **CHAT-01**: User can start a conversation thread using tree branches
- **CHAT-02**: Chat messages render with conversational UI within tree nodes

### Collaboration

- **COLB-01**: User can share trees/branches with team members
- **COLB-02**: Multiple users can edit the same tree concurrently

### Web

- **WEB-01**: User can access notes via web browser
- **WEB-02**: Web app shares the same Rust backend as desktop

## Out of Scope

| Feature | Reason |
|---------|--------|
| Graph / knowledge graph view | Massive UI complexity, rarely used after novelty, doesn't fit tree-primary model |
| Bidirectional links / block references | Changes data model from tree to DAG, enormous complexity for unvalidated value |
| Daily notes / journal mode | Imposes specific workflow conflicting with universal tree metaphor |
| Real-time collaboration | Incompatible with local-first + iCloud sync architecture |
| Plugin / extension system | Premature extensibility before core is stable |
| Kanban / board view | View switching adds UX complexity not needed for tree-first UX |
| Auto-organizing AI | Unsolicited structural changes disorienting in personal knowledge tool |
| Managed cloud / hosted sync | Billing, auth, GDPR, uptime — deferred; iCloud covers v1 |
| Mobile app | Desktop-first, not planned |
| Local/on-device LLM | User API keys only for v1 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TREE-01 | Phase 2 | Complete |
| TREE-02 | Phase 2 | Complete |
| TREE-03 | Phase 2 | Complete |
| TREE-04 | Phase 2 | Complete |
| TREE-05 | Phase 3 | Complete |
| TREE-06 | Phase 2 | Complete |
| EDIT-01 | Phase 3 | Pending |
| EDIT-02 | Phase 3 | Pending |
| EDIT-03 | Phase 3 | Pending |
| EDIT-04 | Phase 3 | Pending |
| AGNT-01 | Phase 4 | Pending |
| AGNT-02 | Phase 4 | Pending |
| AGNT-03 | Phase 5 | Pending |
| AGNT-04 | Phase 5 | Pending |
| AGNT-05 | Phase 5 | Pending |
| INFR-01 | Phase 4 | Pending |
| INFR-02 | Phase 1 | Complete |
| INFR-03 | Phase 6 | Pending |
| INFR-04 | Phase 1 | Complete |

**Coverage:**
- v1 requirements: 19 total
- Mapped to phases: 19
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-24*
*Last updated: 2026-03-24 — traceability mapped during roadmap creation*
