# Phase 4: Agent Infrastructure - Context

**Gathered:** 2026-03-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Pi agent SDK embedded as Node.js sidecar, slash commands trigger agent skills that stream results into the tree. Delivers AGENT-01 (sidecar runtime), AGENT-02 (slash command UX), AGENT-03 (context passing), AGENT-04 (streaming output), AGENT-05 (API key management). Three initial skills: /ask, /research, /brainstorm.

</domain>

<decisions>
## Implementation Decisions

### Slash Command UX
- Slash commands trigger anywhere in a node (not just start of line), via autocomplete dropdown (Notion/Slack style)
- User types '/' + characters, autocomplete suggests matching skills, selecting one triggers it
- Everything after the skill name is the inline argument/prompt (e.g., '/research quantum computing')
- The command text is stored in node metadata (not visible in node content) — the node appears clean but the prompt is recoverable
- No dialog/form for arguments — inline args only, keeping interaction fast and lightweight

### Streaming & Generation UX
- Agent output streams token-by-token in real-time (SSE/streaming from sidecar to frontend)
- Skills can either replace the triggering node's content OR create 1 or multiple children — skill declares its output mode
- User can cancel active generation with Escape key
- Fully concurrent: user can edit other nodes while agent streams into a different node
- Generated nodes have node_type='agent_response' with sparkle icon (already implemented in Phase 3)

### Context & Conversation Model
- Full ancestor chain from root to triggering node is sent as context
- Previous agent responses (node_type='agent_response') in the ancestor chain become assistant messages; user nodes become user messages — creates natural multi-turn conversation from tree structure
- When ancestor chain exceeds model context window, older ancestors are summarized (extra model call) while recent ones are kept in full
- Agent can only create new nodes — cannot read or modify existing nodes beyond what's in the sent context

### API Key Management
- API keys stored in an encrypted local file in app data directory
- Multi-provider from start: Anthropic, OpenAI, Google (Gemini) — abstract provider interface
- Dedicated settings page accessible from gear icon for managing API keys (add/edit/delete per provider)
- Global default model in settings, with per-request override via flag (e.g., '/ask --model opus')

### Initial Skills
- /ask — generic chat, sends context + prompt to model, creates child response node
- /research — deeper investigation, longer response, may create multiple child nodes
- /brainstorm — generates bullet-point ideas as multiple child nodes

### Claude's Discretion
- Sidecar architecture (Node.js process management, IPC protocol)
- Encrypted file format and encryption approach
- Autocomplete dropdown styling and positioning
- Streaming protocol between sidecar and frontend (SSE vs WebSocket vs Tauri events)
- Context summarization prompt design
- Exact skill system extensibility API

</decisions>

<specifics>
## Specific Ideas

- Tree structure IS the conversation — ancestors are the thread, the outliner is the session. This is the core product insight from PROJECT.md
- Slash commands should feel as fast as Notion's — type '/', see options instantly, select and go
- Multi-turn conversation emerges naturally from the tree hierarchy without any explicit "chat mode"
- The command prompt stored in metadata means users can see what was asked via node details but the tree stays clean

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `node_type` column and `agent_response` type already exist with sparkle icon rendering (Bullet.tsx)
- `skill_id` column already on nodes table (Phase 1 schema) — ready for linking nodes to skills
- `changeNodeType` IPC command exists for "Make mine" conversion
- `createNode` IPC with full params (parent_id, position, content, metadata, node_type)
- `getAncestors` IPC command returns ordered ancestor chain — ready for context building
- TipTap `@tiptap/suggestion` already used for hashtag autocomplete — same pattern can power slash command autocomplete

### Established Patterns
- Zustand store with async IPC actions (treeStore.ts)
- Debounced content persistence (300ms)
- Tauri v2 IPC with specta type generation (bindings.ts)
- SQLite backend with sqlx runtime queries

### Integration Points
- New Rust commands needed: settings CRUD, sidecar lifecycle management
- Node.js sidecar needs Tauri sidecar configuration in tauri.conf.json
- Slash command autocomplete integrates into TipTap editor (similar to HashtagNode extension)
- Settings page needs new route/component alongside OutlinerView
- Streaming needs Tauri event system or direct sidecar-to-frontend channel

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-agent-infrastructure*
*Context gathered: 2026-03-29*
