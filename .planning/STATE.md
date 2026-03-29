---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: planning
stopped_at: Completed 04-01-PLAN.md
last_updated: "2026-03-29T07:04:41.171Z"
last_activity: 2026-03-24 — Roadmap created, ready for Phase 1 planning
progress:
  total_phases: 6
  completed_phases: 2
  total_plans: 16
  completed_plans: 12
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-24)

**Core value:** The tree is the universal data structure — every note, conversation, and piece of generated content lives as a node, and an AI agent can operate on any branch using configurable skills.
**Current focus:** Phase 1 — Storage Foundation

## Current Position

Phase: 1 of 6 (Storage Foundation)
Plan: 0 of TBD in current phase
Status: Ready to plan
Last activity: 2026-03-24 — Roadmap created, ready for Phase 1 planning

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**
- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 01-storage-foundation P01 | 7min | 2 tasks | 13 files |
| Phase 01-storage-foundation P02 | 25min | 2 tasks | 4 files |
| Phase 02-core-outliner P01 | 6min | 3 tasks | 13 files |
| Phase 02-core-outliner P02 | 3min | 2 tasks | 9 files |
| Phase 02-core-outliner P02 | 45min | 3 tasks | 9 files |
| Phase 02-core-outliner P03 | 4min | 2 tasks | 5 files |
| Phase 03-search-and-editing P01 | 30min | 2 tasks | 13 files |
| Phase 03-search-and-editing P04 | 3min | 1 tasks | 9 files |
| Phase 03-search-and-editing P02 | 6min | 2 tasks | 9 files |
| Phase 03-search-and-editing P03 | 10min | 2 tasks | 14 files |
| Phase 03-search-and-editing P05 | 15min | 2 tasks | 4 files |
| Phase 03-search-and-editing P06 | 20min | 2 tasks | 4 files |
| Phase 04-agent-infrastructure P01 | 5min | 2 tasks | 11 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Pre-Phase 1]: Tauri v2 + Rust backend — lightweight vs Electron, Rust reuse for server component
- [Pre-Phase 1]: Node.js sidecar required for Vercel AI SDK — WebView cannot run Node.js directly
- [Pre-Phase 1]: SQLite adjacency list with UUID PKs and fractional indexing — positional IDs cause sync corruption
- [Pre-Phase 1]: NSFileCoordinator required for iCloud + SQLite — direct placement causes silent DB corruption
- [Phase 01-storage-foundation]: specta rc.22 required (not rc.20) — tauri-specta rc.21 depends on specta rc.22; specta serde_json feature needed for serde_json::Value fields
- [Phase 01-storage-foundation]: Node.node_type stored as String in struct; NodeType enum used at IPC layer with explicit to_db_str()/from_db_str() methods
- [Phase 01-storage-foundation]: WAL mode set via SqliteConnectOptions only — not in migration SQL to avoid sqlx migrate! issues
- [Phase 01-storage-foundation]: Manual sqlx row extraction for content/metadata: TEXT in SQLite requires intermediate serde_json::from_str, derive(FromRow) cannot handle this
- [Phase 01-storage-foundation]: IS operator for NULL parent_id in get_children — SQLite = NULL is always false, IS ?1 handles both NULL (roots) and non-NULL (children)
- [Phase 01-storage-foundation]: Dynamic SET clause for update_node: only update provided Option<T> fields, never clobber unset fields with null
- [Phase 02-core-outliner]: @vitejs/plugin-react v4 required (not v6) — v6 requires vite 8, project uses vite 6
- [Phase 02-core-outliner]: TreeNode.children is always TreeNode[] (never undefined) for Workflowy-style any-node-can-have-children
- [Phase 02-core-outliner]: positionForMove excludes dragIds before computing key to prevent self-interference during drag
- [Phase 02-core-outliner]: move_node integration tests use raw SQL consistent with Phase 1 test patterns
- [Phase 02-core-outliner]: moveNodeIpc uses direct invoke() not commands.moveNode — bindings.ts regenerates only on cargo tauri dev/build
- [Phase 02-core-outliner]: @tauri-apps/api installed as npm dep for getCurrentWindow/setTitle window title support
- [Phase 02-core-outliner]: react-arborist controlled mode: onToggle delegates to store toggleNode, data prop is sole source of truth
- [Phase 02-core-outliner]: Text editing (TipTap) deferred to Plan 02-03 — NodeRow renders plain text for now; tree rendering infrastructure complete
- [Phase 02-core-outliner]: TipTap Extension options via configure() for keyboard handler callbacks to prevent stale closures in React
- [Phase 02-core-outliner]: editingNodeId in zustand store (not local state) enables single TipTap instance pattern — one active editor at a time
- [Phase 02-core-outliner]: batchOutdent processes bottom-to-top to prevent parent conflicts during sequential outdents
- [Phase 03-search-and-editing]: shouldFilter=false on cmdk: server-side FTS5 search requires disabling cmdk's built-in UUID-based item filtering
- [Phase 03-search-and-editing]: Direct invoke() for create_node/update_node in ipc.ts: bindings.ts stale (gitignored), content_text param needs bypass
- [Phase 03-search-and-editing]: content_text extracted on frontend via extractText(): Rust has no ProseMirror parser, keeps Rust decoupled from TipTap schema
- [Phase 03-search-and-editing]: SparkleIcon inline SVG in Bullet.tsx — no external icon library for single icon
- [Phase 03-search-and-editing]: Make mine uses optimistic updateNodeLocally() — sparkle disappears immediately without IPC round-trip
- [Phase 03-search-and-editing]: Global contextmenu preventDefault removed from main.tsx — AI nodes require legitimate context menu
- [Phase 03-search-and-editing]: change_node_type dedicated command updates only node_type + updated_at — avoids update_node dynamic SET complexity
- [Phase 03-search-and-editing]: ON DELETE CASCADE workaround in undo_history: read all entry data before node deletion, re-insert with PRAGMA foreign_keys=OFF after cascade to preserve redo stack
- [Phase 03-search-and-editing]: UndoGroupTracker at module level in treeStore.ts to avoid React re-renders on every keystroke; 1s gap or nodeId change triggers new undo group
- [Phase 03-search-and-editing]: HashtagNode as atom Node (not Mark) — hashtags are atomic units, prevents partial text selection
- [Phase 03-search-and-editing]: registerTagClickHandler in Zustand store — avoids prop drilling through react-arborist tree
- [Phase 03-search-and-editing]: extractHashtags() walks ProseMirror JSON on frontend — keeps Rust decoupled from TipTap schema
- [Phase 03-search-and-editing]: FTS5 external-content rebuild: INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild') is idempotent startup fix for existing databases, migration backfill handles fresh installs
- [Phase 03-search-and-editing]: StarterKit history: false + no Mod-z in OutlinerKeys: single App.tsx capture-phase handler is sole source of Cmd+Z, eliminates double undo() per keypress
- [Phase 03-search-and-editing]: undo() records pending flush before undoStepIpc: recordUndoStepIpc called with current node content as after_json to ensure active typing session is committed to DB before stepping back
- [Phase 03-search-and-editing]: readOnlyExtensions array defined outside NodeRow component for stable TipTap extension reference
- [Phase 03-search-and-editing]: __create__:tagname prefix convention signals create-new action in hashtag suggestion items without changing string[] type contract
- [Phase 03-search-and-editing]: StarterKit undoRedo:false replaces history:false — API renamed in installed version
- [Phase 04-agent-infrastructure]: Agent commands excluded from tauri-specta collect_commands — tauri::State and AppHandle don't derive Specta; registered in tauri::generate_handler\! instead
- [Phase 04-agent-infrastructure]: Placeholder binary ai-sidecar-aarch64-apple-darwin required for Tauri externalBin build validation — real pkg binary added in Plan 04
- [Phase 04-agent-infrastructure]: rewriteRelativeImportExtensions in tsconfig for NodeNext .ts imports — rewrites to .js in output without noEmit

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 1]: NSFileCoordinator in Rust/Tauri has sparse documentation — needs proof-of-concept spike
- [Phase 1]: Drizzle ORM proxy driver for Tauri is community-documented, not official — validate early
- [Phase 4]: Node.js sidecar notarization via pkg is a niche pattern — needs validation before Phase 4 completes
- [Phase 6]: NSFilePresenter in Rust requires objc crate or Swift interop — low documentation coverage

## Session Continuity

Last session: 2026-03-29T07:04:41.169Z
Stopped at: Completed 04-01-PLAN.md
Resume file: None
