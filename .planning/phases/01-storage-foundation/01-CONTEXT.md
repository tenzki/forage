# Phase 1: Storage Foundation - Context

**Gathered:** 2026-03-24
**Status:** Ready for planning

<domain>
## Phase Boundary

SQLite schema with UUID node identity, Tauri IPC layer, and local file storage. Delivers INFR-02 (local persistence) and INFR-04 (node types for chat mode). No UI in this phase — only the data layer and typed IPC commands.

</domain>

<decisions>
## Implementation Decisions

### Node Schema
- Rich text (structured) content format — store TipTap/ProseMirror JSON, not plain text
- Fractional indexing for sibling ordering (no reindexing on insert/move)
- UUID primary keys for all nodes
- Adjacency list for parent-child relationships
- Metadata columns: created_at, updated_at, collapsed state (boolean), creator source (user vs agent), skill reference (which skill generated this node, nullable)
- Optional metadata JSON column for future extensibility (attachments, embeds, etc.)
- Schema-ready for attachments but no attachment support in v1

### Pi Session Architecture
- Pi sessions are ephemeral — reconstructed from the outliner tree on demand
- No separate Pi session storage needed — the node tree IS the source of truth
- When slash command triggers, system builds Pi session context from node ancestors
- Slash command output replaces the command node content (not preserved as visible text)
- Original prompt stored in metadata JSON column (recoverable but not displayed)
- Agent-generated nodes store generation metadata: model used, skill used, token count in metadata JSON

### Node Types
- Strict enum: `note`, `agent_response`, `command`, `chat_message`
- `note` = user-created (default)
- `agent_response` = AI-generated content
- `command` = slash command node (during/before execution)
- `chat_message` = reserved for future chat mode (v2)
- Phase 1 stores the type but all nodes render identically — visual distinction is Phase 2/3

### File Location
- Local-first during development: `~/Library/Application Support/ai-chat/`
- Migration to iCloud Drive folder deferred to Phase 6
- Single document (one SQLite file = one tree) for v1
- WAL mode enabled from day one for concurrent read performance
- WAL sidecar files (-wal, -shm) travel with the DB during future migration

### Claude's Discretion
- Exact SQLite column types and indexes
- IPC command naming and grouping via tauri-specta
- Migration tooling choice
- Error handling strategy for corrupt/missing DB file

</decisions>

<specifics>
## Specific Ideas

- 1:1 mapping between outliner nodes and Pi session branches — the tree is the universal primitive for both notes and conversations
- Content + generation metadata stored together — model, skill, token count in metadata JSON for agent-generated nodes
- Workflowy-style single infinite tree, no workspaces or multiple documents

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — greenfield project

### Established Patterns
- None — first phase establishes all patterns

### Integration Points
- Tauri IPC layer (tauri-specta) will be consumed by Phase 2 (React frontend)
- SQLite schema will be extended by Phase 3 (search via FTS5)
- Metadata JSON column will be read by Phase 4 (agent infrastructure)

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-storage-foundation*
*Context gathered: 2026-03-24*
