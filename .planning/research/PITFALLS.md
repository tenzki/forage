# Pitfalls Research

**Domain:** Tree-based note-taking / infinite outliner with AI agent — Tauri desktop, local-first, iCloud sync
**Researched:** 2026-03-24
**Confidence:** MEDIUM (domain-specific findings; some iCloud/Tauri combination gaps remain due to sparse official docs for that exact pairing)

---

## Critical Pitfalls

### Pitfall 1: SQLite Database Corruption via iCloud Drive Sync

**What goes wrong:**
SQLite stores the database in a single file (or WAL pair). iCloud Drive syncs files at the byte-stream level without any awareness of SQLite's locking protocol. When iCloud pushes a partial sync while the app is mid-write, the database file on disk becomes an inconsistent state. WAL mode makes this worse: iCloud may sync the `.db` file without syncing the corresponding `-wal` and `-shm` sidecar files, producing a "database disk image is malformed" error that can silently corrupt user data.

**Why it happens:**
Developers assume iCloud Drive behaves like Dropbox or a network filesystem and do simple path-based sync. SQLite's advisory locking (`fcntl`) does not work correctly over any network or cloud-managed filesystem. iCloud Drive is not a block-device-level sync mechanism; it syncs file snapshots and does not serialize around open SQLite connections.

**How to avoid:**
- Never place an active SQLite database directly inside an iCloud Drive container while the database is open for writes.
- Use one of two safe patterns:
  1. **Separate local + export approach**: Store the live database in `Application Support` (outside iCloud). On save/checkpoint, export a JSON or flat-file snapshot into the iCloud container. Reconstruct from snapshot on first launch after sync.
  2. **CloudKit private database**: Use CloudKit's record API (via a Tauri Rust plugin wrapping `CloudKit.framework`) rather than iCloud Drive file sync entirely.
- If staying with file sync, exclude WAL sidecar files using `.nosync` suffixes and checkpoint to a single-file database before iCloud can touch it, then use `NSFileCoordinator` for all writes.

**Warning signs:**
- "Database disk image is malformed" errors in user bug reports.
- Users report data loss after switching between two Macs.
- App opens empty on a second device even though sync appears complete.

**Phase to address:** Storage foundation phase (before any sync wiring)

---

### Pitfall 2: Tree Node ID Instability Breaking Sync and Undo

**What goes wrong:**
Nodes in an infinite outliner are reordered, indented, unindented, moved across branches, and deleted constantly. If node identity is based on positional indices (array position, ordinal, or path strings like `0.2.1`) rather than stable UUIDs, any concurrent edit or sync merge will map operations onto the wrong node, silently corrupting the tree. Similarly, undo/redo that replays "move node at index 3" fails catastrophically after any intervening edit.

**Why it happens:**
Positional indexing is the simplest mental model for a tree and it works fine for a single user on a single device. The problem only surfaces during sync (two devices edit simultaneously) or complex undo sequences. By then, the data model is deeply embedded.

**How to avoid:**
- Assign a permanent UUID to every node at creation time. Never reassign or reuse IDs.
- All operations (move, indent, delete, reparent) reference nodes by UUID.
- Tree order within siblings is encoded as a fractional index (e.g., a string or float that allows inserting between two siblings without renumbering). Libraries like `fractional-indexing` (npm) implement this correctly.
- Undo/redo stack stores inverse operations referencing UUIDs, not positions.

**Warning signs:**
- "Move" operations in undo log reference indices, not IDs.
- A merge function that computes "position delta" rather than "which UUID moved where."
- Any test that breaks when two unrelated edits happen in a different order.

**Phase to address:** Core data model phase (before any UI is built on top)

---

### Pitfall 3: Tauri macOS Sandbox Blocking iCloud and Network Simultaneously

**What goes wrong:**
For Mac App Store distribution, Tauri apps must enable the App Sandbox. The sandbox requires explicit entitlements for: iCloud ubiquitous containers (`com.apple.developer.ubiquity-container-identifiers`), outgoing network access (`com.apple.security.network.client`), and file access beyond the app bundle. Developers commonly configure these individually but fail to account for how the Tauri Rust backend's `reqwest`-based HTTP client is blocked by the sandbox in production builds even when the entitlement is present — because the entitlement must also be embedded in the correct target (main binary vs. helper processes).

**Why it happens:**
Tauri compiles multiple binaries (main app, helper, renderer). Sandbox entitlements attached only to the top-level bundle do not automatically propagate to all helpers. The issue is invisible in debug builds (sandbox not enforced) and only surfaces in notarized/App Store builds. Developers discover it after submission.

**How to avoid:**
- Configure `Entitlements.plist` in `src-tauri/` to include all required entitlements for both the main target and any helper targets.
- Test with hardened runtime and sandbox enabled locally before submission: `codesign --entitlements entitlements.plist --force --sign "Developer ID" MyApp.app`.
- Required entitlements for this project:
  - `com.apple.security.app-sandbox: true`
  - `com.apple.security.network.client: true`
  - `com.apple.developer.icloud-container-identifiers` (for CloudKit) or iCloud Drive ubiquity identifiers
  - `com.apple.security.files.user-selected.read-write` if user picks file locations
- Validate outgoing HTTP from Rust code (not just the WebView) in a sandboxed test build early.

**Warning signs:**
- All HTTP requests work in `tauri dev` but silently fail in release build.
- iCloud container returns `nil` or permission errors only in notarized builds.
- `codesign -dv --entitlements - MyApp.app` does not list expected keys.

**Phase to address:** Distribution/packaging phase, but entitlements structure must be established in the initial Tauri project setup phase

---

### Pitfall 4: Agent Context Naively Uses Entire Tree, Hitting Token Limits

**What goes wrong:**
When a user triggers `/research concurrent companies for LambdaWorks` inside a deeply nested branch, the naive implementation serializes the entire tree as context and sends it to the LLM. With even a few hundred nodes this exceeds economical context limits (4K–32K tokens for cost-conscious operation), and with a large knowledge base it can exceed model limits entirely. Worse, LLMs exhibit "context rot" — their ability to attend to relevant content degrades as total context length grows, so including irrelevant nodes actively hurts output quality.

**Why it happens:**
Serializing everything is the simplest implementation. It works in demos where the tree is small. It becomes unusable in production.

**How to avoid:**
- Define a context scope per agent invocation: the triggered node, its ancestors to root (breadcrumb context), and its immediate children (branch context). Siblings and distant branches are excluded by default.
- Implement configurable scope depth. Default: 2 levels up + 2 levels down from triggered node.
- For skills that need broader context (e.g., "summarize this entire project"), provide an explicit override rather than making it the default.
- Serialize context as a compact token-efficient format (indented plain text or YAML-like structure) rather than JSON with metadata.

**Warning signs:**
- Agent calls that include more than ~50 nodes in context by default.
- Any code path that calls `serializeWholeTree()` before constructing the prompt.
- Slow response times and high API costs even for simple single-node operations.

**Phase to address:** Agent integration phase (before any skill implementation)

---

### Pitfall 5: Streaming LLM Output Into Tree Nodes Without Cancellation

**What goes wrong:**
LLM responses are streamed token by token. If the app starts appending tokens to a tree node as they arrive but has no cancellation mechanism, the user cannot stop a bad generation. Partial nodes left behind after an interrupted generation (network drop, app crash, user navigation) corrupt the tree state with half-populated children. Additionally, Tauri's WebView layer does not natively stream HTTP responses — `wry`'s response type is a fixed `Vec<u8>`, so streaming must be implemented via Tauri events from the Rust backend, not via direct `fetch()` streaming in the frontend.

**Why it happens:**
Developers prototype streaming with a standard `fetch()` EventSource in the WebView, which works in the browser but Tauri's HTTP interception layer intercepts it differently. The cancellation path is then an afterthought.

**How to avoid:**
- Use Tauri's event system (`emit`/`listen`) for streaming: the Rust backend streams from the LLM API using `reqwest` with `bytes_stream()`, then emits events to the frontend for each token chunk.
- Implement a cancellation token on the Rust side: store active generation tasks in a `HashMap<TaskId, CancellationToken>`, expose a `cancel_generation(task_id)` Tauri command.
- Never write partial AI output directly into the canonical node. Buffer the generation result, then commit atomically when complete (or discard on cancel).
- Mark nodes as `generating: true` in UI state during generation; clean up this flag on completion, cancellation, or error.

**Warning signs:**
- Frontend uses `fetch()` or `EventSource` directly against an LLM API endpoint without going through the Rust backend.
- No "Stop" button in the UI during generation.
- After a crash, reloading the app shows nodes with empty content or partial AI text.

**Phase to address:** Agent streaming infrastructure phase

---

### Pitfall 6: iCloud Conflict Resolution Silently Picking Wrong Version

**What goes wrong:**
When the same note is edited on two Macs before sync completes, iCloud creates conflicting versions. For file-based sync (iCloud Drive), conflicting versions are surfaced via `NSFileVersion` — but only if the app implements `NSFilePresenter`. Most apps skip this, so iCloud silently picks "last writer wins" based on modification timestamp, which discards the other edit with no user notification. For this project where notes are the primary value, silent data loss is catastrophic.

**Why it happens:**
File coordination via `NSFileCoordinator`/`NSFilePresenter` is complex and verbose. It requires inter-process communication, and the protocols are "very expensive objects" per Apple's documentation. Developers defer it, ship without it, and users lose data.

**How to avoid:**
- Use `NSFileCoordinator` for all reads and writes to the iCloud container. Never write directly to an iCloud path without coordination.
- Implement `NSFilePresenter` to receive conflict notifications. When `presentedItemDidChange` fires, check `NSFileVersion.unresolvedConflictVersionsOfItem(at:)` and surface a conflict resolution UI if auto-merge is not possible.
- For tree-structured data, implement "merge both" as default: take all conflicting child nodes as siblings, mark them with a `conflict: true` flag, and let the user reconcile. This is safer than picking a winner.
- Write integration tests that simulate concurrent edits on two "devices" (two separate temp directories) and verify that no data is silently dropped.

**Warning signs:**
- Any file write that does not go through `NSFileCoordinator`.
- No `NSFilePresenter` implementation in the codebase.
- Sync tests only test "one device at a time" scenarios.

**Phase to address:** iCloud sync implementation phase

---

### Pitfall 7: Undo/Redo Breaks Across AI-Generated Content

**What goes wrong:**
Users trigger a slash command, the agent generates 10 child nodes. The user then presses Cmd+Z expecting to undo the last manual keystroke, but instead undoes the entire AI batch, or worse, the undo stack is not scoped correctly and mixing agent operations with manual operations creates a sequence where redo re-applies an agent generation that the user explicitly deleted. This is especially disorienting in a tree editor where generated nodes can be deeply nested.

**Why it happens:**
Undo stacks for manual edits and agent operations are often designed independently. AI operations are treated as "external" and not registered in the undo stack, or they are registered but not as atomic batch operations.

**How to avoid:**
- Register every agent-generated action as a single undoable batch operation: one undo entry for "AI generated N nodes under node X," not N separate entries.
- Give the undo entry a human-readable label: "Undo: Research result (7 nodes)."
- Do not mix AI batch commits into the middle of a pending manual edit operation.
- Consider a separate "AI history" panel (not just undo) where users can see and revert previous generations independently.

**Warning signs:**
- Agent output is written via direct state mutation without going through the undo manager.
- Pressing Cmd+Z 20 times to "undo the AI thing" is the expected behavior in early builds.
- Undo tests do not cover any agent-triggered scenarios.

**Phase to address:** Core editor + agent integration phases (undo architecture must be established before agent is wired in)

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Store API keys in `tauri-plugin-store` (unencrypted JSON) | 30-minute implementation | API keys readable by any process with filesystem access; security incident if user's disk is accessed | Never — use OS keychain from day one |
| Positional indices for tree node ordering | Simple to implement | Breaks sync, breaks undo, requires rewrite when CRDTs/conflict merge added | Never for production data model |
| Serialize full tree as LLM context | Works in demos | Token cost explodes, quality degrades, hits limits with real data | MVP only if tree is capped at <50 nodes |
| SQLite directly inside iCloud Drive container | One-line path setup | Silent data corruption on multi-device usage | Never |
| Skip `NSFileCoordinator` for iCloud writes | Faster dev iteration | Silent data loss on conflict; Apple may reject from App Store | Never |
| Hard-code OpenAI as only provider | Fastest first implementation | Users on Anthropic/Gemini/local models are excluded | MVP only — design provider abstraction early even if only one backend is wired |
| Single flat Rust async task for all agent operations | Simple concurrency model | Cannot cancel individual generations; multiple agent calls block each other | Never — use task registry with per-task cancellation |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| iCloud Drive file sync | Writing SQLite file directly into `~/Library/Mobile Documents/` | Write to `Application Support`, checkpoint/export a structured file to iCloud container |
| CloudKit (if used) | Using HTTP 503 as an application error and not implementing retry | Treat 503 as rate-limit signal; implement exponential backoff with `CKErrorRetryAfterKey` |
| OpenAI / Anthropic streaming | Using WebView `fetch()` with SSE directly | Route all LLM calls through Rust backend via Tauri commands; use `reqwest` byte streaming + emit events |
| User API key storage | `localStorage` or unencrypted store plugin | `tauri-plugin-keyring` (wraps OS keychain: Keychain on macOS, Credential Manager on Windows) |
| macOS App Sandbox + iCloud | Forgetting `com.apple.developer.ubiquity-container-identifiers` entitlement | Add all iCloud entitlements to `Entitlements.plist` in `src-tauri/`; verify with `codesign -dv` |
| LLM provider abstraction | Building directly against `openai` crate | Define a provider trait in Rust: `async fn complete(messages, config) -> Stream<Token>`; implement per provider |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Re-rendering entire tree on any state change | Noticeable lag typing in a node with 100+ siblings | Virtual list / virtualized tree (only render visible nodes); memoize node components | ~200 visible nodes |
| Eager full-tree serialization for search | Search latency grows linearly with note count | Build an in-memory search index (SQLite FTS5 or a simple inverted index in Rust) at startup; update incrementally | ~1,000 nodes |
| Blocking Rust command for LLM calls | UI freezes during generation | All LLM calls must be `async` Tauri commands; Rust side uses `tokio::spawn` | Immediate — first API call |
| Holding open a write transaction during iCloud sync window | Database locked errors; sync conflicts multiply | Close and checkpoint SQLite transaction before iCloud sync runs; use WAL with aggressive checkpointing | Multi-device usage |
| CRDT metadata growth without compaction | Storage file grows unboundedly; load time increases | If using CRDTs, implement periodic compaction/snapshot; store CRDT doc separately from query-optimized SQLite | ~10,000 operations without compaction |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing user API keys in plaintext on disk | Any process with file access can read keys; malicious apps can exfiltrate | Use `tauri-plugin-keyring` to store in OS keychain; never write keys to any file |
| Passing API keys as environment variables or tauri config | Keys visible in process table, build artifacts, crash dumps | Keys must only exist in memory after being read from keychain at runtime |
| Sending full tree content to LLM without scope limits | Privacy: user's private notes sent to third-party API unintentionally | Implement explicit context scoping; show user what will be sent before the first API call |
| Using `allowlist: all` in Tauri capabilities | Expands attack surface; XSS in WebView can invoke any Rust command | Define minimal capability scopes; only expose commands the frontend actually calls |
| Disabling CSP in WebView for convenience | XSS vulnerabilities in rendered note content can execute arbitrary JS | Keep Tauri's default CSP; sanitize any rendered markdown/HTML in notes |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No visual indicator that iCloud sync is in progress | User edits on a second device, doesn't realize sync hasn't completed, overwrites with stale data | Show a sync status badge (syncing / synced / conflict) in the toolbar; update in real time |
| AI generation blocks keyboard interaction | User can't keep typing while agent runs; feels slow | Generating nodes appear as a placeholder "ghost" branch; user can keep editing elsewhere while agent works |
| Slash command invoked accidentally mid-word | `/research` inside a sentence triggers agent unexpectedly | Only trigger slash command UI when `/` is the first non-whitespace character in a node; dismiss on Escape |
| Zoom state lost on restart | User zoomed into a deep branch, quits app, reopens to root — loses orientation | Persist zoom state (focused node UUID) in app state; restore on startup |
| Expanding all nodes at once | Large tree becomes unnavigable; performance degrades | "Expand all" should be bounded to current branch depth; never recursive to all leaves by default |
| Agent errors shown as raw API error strings | "401 Unauthorized" or JSON stack traces exposed to user | Translate all LLM API errors to human-readable messages: "API key invalid — check Settings", "Rate limited — try again in 30s" |

---

## "Looks Done But Isn't" Checklist

- [ ] **iCloud sync:** Shows "synced" badge but only syncs on app quit, not on idle — verify real-time or near-real-time sync with `NSMetadataQuery` watching the container.
- [ ] **Search:** Returns results but does not highlight the matching term in the tree — verify search navigates to and visually marks the matching node.
- [ ] **API key storage:** Key is saved and works in the same session but is lost on app restart — verify round-trip from keychain store to keychain read across restarts.
- [ ] **Undo after AI generation:** Cmd+Z after a generation undoes the generation as an atomic unit, not one node at a time — verify with a test that generates 5 nodes and counts undo steps to zero.
- [ ] **Agent cancellation:** "Stop" button appears during generation and pressing it halts the stream — verify that the Rust-side `reqwest` connection is actually dropped (not just the frontend listener).
- [ ] **Conflict resolution:** Two-device conflict produces a visible conflict marker, not silent data loss — verify with an integration test simulating two concurrent writes to the same file path.
- [ ] **Keyboard navigation:** Tab/Shift-Tab indent/unindent, Enter creates sibling, Cmd+Up/Down moves node — verify that all standard Workflowy-style shortcuts are functional before any AI features are tested.
- [ ] **Zoom state persistence:** Closing the app while zoomed into a sub-branch and reopening returns to that same node — verify focused node UUID is persisted in app state.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| SQLite corruption via iCloud sync | HIGH | Implement an export-to-JSON command immediately; advise users to back up via this export; rebuild from last good JSON snapshot |
| Tree ID instability after shipped release | HIGH | Requires data migration: assign UUIDs to all existing positional nodes; write migration that preserves tree structure; version the schema from day one to enable this |
| Sandbox entitlement blocking iCloud in production | MEDIUM | Add missing entitlements, rebuild, re-notarize, re-submit; no data loss but ~1 week developer time and user-facing downtime |
| Agent context sending full tree (cost overrun) | LOW | Deploy updated scope logic; no data migration needed |
| API keys stored in plaintext discovered | HIGH | Force users to re-enter keys (cannot migrate plaintext → keychain securely); fix storage, notify users, release patch |
| Undo stack not covering AI operations | MEDIUM | Redesign undo manager to accept batch operations; existing undo history cannot be recovered but future operations are correct |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| SQLite + iCloud file corruption | Phase 1: Data model & storage foundation | Integration test: write DB, trigger mock iCloud sync event, reopen DB — no corruption |
| Tree node ID instability | Phase 1: Data model & storage foundation | Unit test: two concurrent "move node" operations produce correct tree regardless of order |
| Tauri sandbox + iCloud entitlements | Phase 2: Tauri app shell setup | Notarized build checklist: `codesign -dv` lists all required entitlements; HTTP calls succeed from sandboxed build |
| Agent context token explosion | Phase 4: Agent integration | Token count assertion in agent test: single-node slash command sends ≤ N tokens |
| LLM streaming without cancellation | Phase 4: Agent integration | Test: start generation, cancel after 1 second, assert no partial nodes remain in tree |
| iCloud conflict resolution | Phase 3: iCloud sync | Integration test: two concurrent writes to same file path; assert both edits visible with conflict marker |
| Undo/redo with AI operations | Phase 4: Agent integration | Test: generate nodes, undo once, assert all AI nodes removed atomically |
| API key security | Phase 2: Tauri app shell setup | Security review: verify no key material written to any file; keychain read/write round-trip test |

---

## Sources

- [What I Learned Writing My Own CloudKit Syncing Library — Ryan Ashcraft](https://ryanashcraft.com/what-i-learned-writing-my-own-cloudkit-sync-library/)
- [In-Depth Guide to iCloud Documents — Fatbobman](https://fatbobman.com/en/posts/in-depth-guide-to-icloud-documents/)
- [Technical Note TN2336: Handling version conflicts in the iCloud environment — Apple](https://developer.apple.com/library/archive/technotes/tn2336/_index.html)
- [How To Corrupt An SQLite Database File — SQLite.org](https://sqlite.org/howtocorrupt.html)
- [iOS iCloud Drive Synchronization Deep Dive — Carlo Zottmann](https://zottmann.org/2025/09/08/ios-icloud-drive-synchronization-deep.html)
- [Is there a built-in safe storage API for securely storing secrets — Tauri Discussion #7846](https://github.com/tauri-apps/tauri/discussions/7846)
- [Tauri macOS Production Build: All Outgoing Network Requests Blocked — Issue #13878](https://github.com/tauri-apps/tauri/issues/13878)
- [Stronghold Plugin — Tauri v2 docs](https://v2.tauri.app/plugin/stronghold/)
- [App Store Distribution — Tauri v2 docs](https://v2.tauri.app/distribute/app-store/)
- [The Context Window Problem: Scaling Agents Beyond Token Limits — Factory.ai](https://factory.ai/news/context-window-problem)
- [TypeScript CRDT Toolkits for Offline-First Apps — Medium](https://medium.com/@2nick2patel2/typescript-crdt-toolkits-for-offline-first-apps-conflict-free-sync-without-tears-df456c7a169b)
- [Streaming LLM Responses — dataa.dev](https://dataa.dev/2025/02/18/streaming-llm-responses-building-real-time-ai-applications/)
- [Streaming response body — Tauri Discussion #3138](https://github.com/tauri-apps/tauri/discussions/3138)
- [Syncing data with CloudKit using CKSyncEngine — Superwall](https://superwall.com/blog/syncing-data-with-cloudkit-in-your-ios-app-using-cksyncengine-and-swift-and-swiftui/)
- [Fixing macOS SwiftData/Core Data Sync: The CloudKit.framework Issue — Fatbobman](https://fatbobman.com/en/snippet/fix-synchronization-issues-for-macos-apps-using-core-dataswiftdata/)
- [Making desktop apps with Tauri + Rust sidecar — Evil Martians](https://evilmartians.com/chronicles/making-desktop-apps-with-revved-up-potential-rust-tauri-sidecar)

---
*Pitfalls research for: tree-based note-taking / infinite outliner with AI agent (Tauri, local-first, iCloud sync)*
*Researched: 2026-03-24*
