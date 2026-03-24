# Feature Research

**Domain:** Tree-based note-taking / infinite outliner with AI agent
**Researched:** 2026-03-24
**Confidence:** HIGH (core outliner features); MEDIUM (AI agent patterns)

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Infinite nested tree / bullet points | Core promise of any outliner; Workflowy set the expectation permanently | LOW | Tree node model must support arbitrary depth from day one |
| Zoom / hoist into node | Any serious outliner has this; Workflowy, Roam, Logseq all have it. Without it users feel trapped in one flat view | LOW | Node becomes the new root; breadcrumb trail back to real root is required UX |
| Expand / collapse branches | Universal expectation; disorienting without it | LOW | Persist collapse state across sessions |
| Keyboard-driven navigation and editing | Power users (primary audience) expect full keyboard control — Tab/Shift-Tab indent, Enter new node, Alt+Arrow move | MEDIUM | Must cover: indent, unindent, move up, move down, zoom in/out, new sibling, delete, select range |
| Global search | Once tree grows beyond ~50 nodes, search becomes mandatory. Users won't stay without it | MEDIUM | Fuzzy match on node text; highlight match in context; navigate directly to result |
| Hashtag / label tagging | Workflowy popularized tags; users expect a fast way to create cross-cutting categories | LOW | Tags are just text tokens (#tag) parsed in node content — no separate data model needed initially |
| Undo / redo | Universal expectation across all text editors and productivity tools | MEDIUM | Must cover structural operations (move, indent, delete) not just text edits |
| Drag to reorder nodes | Mouse users expect drag-and-drop; keyboard covers the same use case but drag is a table stake UX | MEDIUM | Must handle drag across collapsed branches and different nesting levels |
| Persist data across sessions | Local-first means data must survive app restarts reliably; any data loss immediately destroys trust | LOW | Covered by storage layer but must be validated from day one |
| Readable text rendering | Plain text display with clean typography; no visual clutter | LOW | Markdown inline formatting (bold, italic, code) is increasingly expected |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not required, but valued.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Slash commands triggering AI agent | Inline flow — user never leaves the note context to interact with AI. `/research`, `/expand`, `/summarize` feel native to the outline | HIGH | Command palette parsing, context extraction, async streaming response into child nodes |
| Agent generates child notes from branch context | AI reads parent + sibling context to generate structured child nodes — feels like having a research partner that understands your current focus | HIGH | Context window management: how many ancestor nodes to include, token budget per request |
| Configurable agent skills per workspace/branch | Different workflows need different AI behaviors: "research mode" vs "design critique" vs "brainstorm" — not a generic chatbot | HIGH | Skill = system prompt + tool config. Storage in local DB. UI for creating/editing skills |
| AI generates inline content on current node | Inline generation (not just child creation) lets users expand a bullet in place — augments writing rather than branching | MEDIUM | Streaming text into existing node text; clear visual feedback during generation |
| User-provided API keys (BYOK) | No billing infrastructure for v1; appeals to privacy-conscious users and developers; no vendor lock-in | LOW | Key storage (OS keychain), key validation on entry, graceful error messaging on failure |
| Tree as reusable chat interface | Same data model will power chat conversations later — each branch = a thread. Architectural differentiation, not visible to v1 users | HIGH | Architectural decision, not a v1 feature. But data model must support `node.type` to distinguish note vs message |
| Local-first with iCloud sync | Offline-first guarantee + cross-device sync without a managed cloud backend. Obsidian proved this market exists and users love it | MEDIUM | iCloud Drive file-based sync; must handle sync conflicts gracefully |
| Workflowy-quality speed on large trees | Workflowy's reputation is built on responsiveness. Rust/Tauri backend enables this — makes it feel snappier than Electron-based competitors | MEDIUM | Virtual rendering for large trees; lazy load collapsed branches |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Graph / knowledge graph view | Roam and Logseq popularized it; users ask for it. Looks impressive in screenshots | Adds massive UI complexity, rarely used after novelty wears off, confuses new users, does not fit the tree-primary model | Focus on search and backlinks as text. Add graph view only if validated by real user demand post-v1 |
| Bidirectional links / block references | Roam made this famous; power users love cross-referencing | Fundamentally changes the data model from a simple tree to a DAG. Enormous complexity for unvalidated value. Most users never use block refs deeply | Support `[[wiki-style links]]` as a future milestone. Do not make it a v1 dependency |
| Daily notes / journal mode | Logseq and Roam center on daily notes as the primary entry point | Imposes a specific workflow. This product's tree-first model is different and more flexible. Daily notes would conflict with the universal tree metaphor | A "Today" or "Inbox" top-level node is sufficient; no date-stamped pages needed |
| Real-time collaboration / multiplayer | Users assume modern apps support this | Fundamentally incompatible with local-first + iCloud sync architecture for v1. Adds auth, conflict resolution (CRDT), and infra complexity beyond scope | Explicitly out of scope for v1. Document as roadmap item for post-v1 |
| Plugin / extension system | Power users want to extend the app | Plugins require a stable public API, documentation, and maintenance burden before core is solid. Premature extensibility creates tech debt | Define internal skill/agent system cleanly so it can be opened as an API later |
| Kanban / board view | Workflowy added it; users request alternative views | View switching adds UX complexity and requires the data model to carry view metadata. Not needed for tree-first UX | Tree with collapse/expand and zoom is sufficient. Consider as v2+ view |
| AI that auto-organizes / reorganizes tree without user command | "Smart" suggestions feel helpful in demos | Unsolicited structural changes are deeply disorienting in a personal knowledge tool. Users lose their mental model of where things live | All AI actions must be explicitly triggered by slash commands. Never autonomous restructuring |
| Managed cloud / hosted sync | Convenience | Billing, auth, GDPR, uptime, cost — all deferred deliberately. iCloud sync covers v1 use case | iCloud sync for v1; cloud service as future milestone |

---

## Feature Dependencies

```
[Infinite nested tree]
    └──requires──> [Local storage / persistence]
                       └──enables──> [iCloud sync]

[Zoom into node]
    └──requires──> [Infinite nested tree]
    └──requires──> [Breadcrumb trail UI]

[Global search]
    └──requires──> [Infinite nested tree]
    └──enhances──> [Hashtag tagging] (can filter by tag)

[Slash command AI agent]
    └──requires──> [Infinite nested tree]
    └──requires──> [User API key storage]
    └──requires──> [Agent skill configuration]
    └──produces──> [Child node generation]
    └──produces──> [Inline content generation]

[Agent generates child nodes]
    └──requires──> [Slash command AI agent]
    └──requires──> [Branch context extraction]

[Configurable agent skills]
    └──requires──> [User API key storage]
    └──enhances──> [Slash command AI agent]

[iCloud sync]
    └──requires──> [Local-first persistence]
    └──conflicts──> [Real-time collaboration] (different sync models)

[Keyboard navigation]
    └──enhances──> [Infinite nested tree]
    └──enhances──> [Zoom into node]
```

### Dependency Notes

- **Zoom requires breadcrumb trail:** Without visible path back to root, users lose orientation in the tree. Zoom and breadcrumb are inseparable UX.
- **Slash commands require API key storage:** No agent interaction is possible without a configured provider key. Key setup must be in the onboarding flow.
- **Agent skills enhance slash commands:** Skills are the configuration layer that makes slash commands context-aware. Raw slash commands without skills would produce generic, low-value output.
- **iCloud sync conflicts with real-time collaboration:** iCloud Drive file-based sync does not support CRDT-style concurrent edits. These are architecturally incompatible paths.
- **Branch context extraction is a hidden dependency:** For agent child generation to be useful, the system must assemble a meaningful context window from ancestors, the current node, and siblings. This is non-trivial and must be designed early.

---

## MVP Definition

### Launch With (v1)

Minimum viable product — what is needed to validate the concept.

- [ ] Infinite nested tree with expand/collapse — core data model and rendering
- [ ] Zoom / hoist into any node with breadcrumb trail — without this it is not a real outliner
- [ ] Full keyboard navigation — Tab/Shift-Tab, Enter, Alt+Arrow, delete
- [ ] Global search across all nodes — mandatory once tree exceeds trivial size
- [ ] Undo / redo for structural and text operations — data trust depends on this
- [ ] Local-first persistence (SQLite or equivalent) — data survives restarts
- [ ] User API key configuration (OpenAI, Anthropic) — prerequisite for all AI features
- [ ] Slash command trigger (`/command text`) parsed from node content — primary agent interaction model
- [ ] Agent generates child nodes using branch context — core AI value proposition
- [ ] At least one built-in skill (e.g., "research") — validates the skill model without requiring users to configure from scratch
- [ ] iCloud sync — cross-device use, important for daily driver adoption

### Add After Validation (v1.x)

Features to add once core is working.

- [ ] Configurable agent skills (custom system prompts) — add when users hit limits of built-in skills
- [ ] Agent inline content generation (write into current node) — add when users ask for augmentation not just child creation
- [ ] Hashtag filtering in search — add when users have enough nodes that search alone is insufficient
- [ ] Inline Markdown rendering (bold, italic, code) — add when content richness becomes a complaint
- [ ] Multiple built-in skills — add based on which use cases v1 users actually adopt

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] Chat / conversation mode using tree nodes — architectural groundwork laid in v1 data model
- [ ] `[[wiki-style links]]` between nodes — only if users demand cross-referencing
- [ ] Plugin / skill API — only after skill model is stable and battle-tested
- [ ] Web app — explicitly out of scope for v1
- [ ] Team collaboration — requires auth, CRDT sync, and infra; not a personal tool problem

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Infinite nested tree | HIGH | LOW | P1 |
| Zoom / hoist into node | HIGH | LOW | P1 |
| Keyboard navigation | HIGH | MEDIUM | P1 |
| Local-first persistence | HIGH | LOW | P1 |
| Undo / redo | HIGH | MEDIUM | P1 |
| Global search | HIGH | MEDIUM | P1 |
| iCloud sync | HIGH | MEDIUM | P1 |
| User API key storage | HIGH | LOW | P1 |
| Slash command parsing | HIGH | MEDIUM | P1 |
| Agent child node generation | HIGH | HIGH | P1 |
| Built-in research skill | HIGH | MEDIUM | P1 |
| Expand / collapse | HIGH | LOW | P1 |
| Drag to reorder | MEDIUM | MEDIUM | P2 |
| Hashtag tagging + search filter | MEDIUM | LOW | P2 |
| Inline Markdown rendering | MEDIUM | LOW | P2 |
| Configurable custom skills | HIGH | MEDIUM | P2 |
| Agent inline generation | MEDIUM | MEDIUM | P2 |
| Multiple built-in skills | MEDIUM | MEDIUM | P2 |
| Chat / conversation tree mode | HIGH | HIGH | P3 |
| Wiki-style links | LOW | HIGH | P3 |
| Plugin API | LOW | HIGH | P3 |
| Graph view | LOW | HIGH | P3 |
| Daily notes mode | LOW | LOW | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

---

## Competitor Feature Analysis

| Feature | Workflowy | Logseq | Roam Research | Tana | Our Approach |
|---------|-----------|--------|---------------|------|--------------|
| Infinite nested tree | Yes, core product | Yes | Yes | Yes | Yes, core product |
| Zoom / hoist | Yes, signature feature | Yes | Yes | Yes | Yes |
| Keyboard navigation | Excellent | Good | Good | Good | Target Workflowy level |
| Bidirectional links | No | Yes (core) | Yes (pioneered) | Via supertags | Deferred to v2+ |
| Graph view | No | Yes | Yes | Yes | Not planned for v1 |
| Daily notes | No | Yes (core) | Yes | Yes | Explicitly not building |
| AI features | Basic (Workflowy AI) | Plugin-based | Basic | Full AI agents + supertags | Slash commands + configurable skills (differentiator) |
| User-provided LLM keys | No | Via plugins | No | No (managed) | Yes, by design |
| Local-first | No (cloud) | Yes | No (cloud) | No (cloud) | Yes |
| iCloud sync | No (own cloud) | Via iCloud Drive | No | No | Yes (v1) |
| Plugin system | No | Yes | No | Supertag API | Not in v1 |
| Search | Yes | Yes | Yes | Yes | Yes |
| Tagging | Yes | Yes | Yes | Yes (supertags) | Basic hashtags |

---

## Sources

- [Workflowy keyboard shortcuts and features](https://workflowy.com/learn/keyboard-shortcuts/) — official docs
- [Logseq block references documentation](https://discuss.logseq.com/t/the-basics-of-logseq-block-references/8458) — community docs
- [Tana 2025 product updates](https://tana.inc/articles/whats-new-in-tana-2025-product-updates) — official announcement
- [Best Workflowy alternatives comparison](https://blog.saner.ai/best-workflowy-alternatives/) — MEDIUM confidence, market survey
- [Best AI Outliner App 2025 - Knowing Blog](https://blog.knowing.app/posts/best-ai-outliner-app-2025/) — MEDIUM confidence, editorial
- [Tana supertags review](https://www.xda-developers.com/tana-supertags-review/) — MEDIUM confidence, third-party review
- [iCloud sync challenges with Obsidian](https://zottmann.org/2025/09/08/ios-icloud-drive-synchronization-deep.html) — MEDIUM confidence, real-world report
- [Outliner evolution analysis](https://molodtsov.me/2020/07/outliners/) — LOW confidence (dated), historical context only

---

*Feature research for: Tree-based note-taking app with AI agent (ai-chat)*
*Researched: 2026-03-24*
