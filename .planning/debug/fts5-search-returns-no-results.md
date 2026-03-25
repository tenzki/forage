---
status: diagnosed
trigger: "Investigate why FTS5 search returns no results in the ai-chat app."
created: 2026-03-25T00:00:00Z
updated: 2026-03-25T00:00:00Z
symptoms_prefilled: true
goal: find_root_cause_only
---

## Current Focus

hypothesis: CONFIRMED - rowid join in FTS5 query is broken because nodes table uses TEXT PRIMARY KEY (UUID), so nodes.rowid is SQLite's implicit integer rowid which is NOT the same as nodes.id. The FTS5 external content table syncs using new.rowid (the integer), but the JOIN in search.rs uses `n.rowid = nodes_fts.rowid`. This join should work in isolation, BUT the UPDATE trigger is broken: the DELETE half of the trigger fires first using old.rowid and then the INSERT fires with new.rowid - these will match the same SQLite rowid so the rowid join itself is mechanically correct.

The real root cause is different - see Resolution.

test: traced full data flow from create_node through FTS5 trigger to search query
expecting: mismatch found in how content_text reaches FTS5
next_action: complete - root cause identified

## Symptoms

expected: Cmd+K popup opens and search returns matching nodes
actual: Cmd+K popup shows but search returns no results for any query
errors: none reported
reproduction: open app, press Cmd+K, type any search term, no results appear
started: unknown

## Eliminated

- hypothesis: SearchOverlay not calling searchNodesIpc
  evidence: SearchOverlay.tsx line 69 clearly calls searchNodesIpc(value) after 200ms debounce with shouldFilter=false; the IPC layer (ipc.ts line 198) calls invoke('search_nodes', {query}) correctly
  timestamp: 2026-03-25

- hypothesis: FTS5 SQL query is structurally broken
  evidence: The JOIN `n.rowid = nodes_fts.rowid` is correct - both sides reference SQLite's internal integer rowid. The BM25 ORDER BY rank is correct. The snippet() call uses column index 0 which matches content_text being the only indexed column.
  timestamp: 2026-03-25

- hypothesis: rowid vs id mismatch
  evidence: nodes table uses `id TEXT PRIMARY KEY` (UUID). SQLite assigns an implicit integer rowid. The FTS5 table uses content_rowid='rowid' which refers to this integer rowid. The triggers INSERT INTO nodes_fts using new.rowid (the integer). The JOIN in search.rs also uses n.rowid = nodes_fts.rowid (both integer). These match correctly.
  timestamp: 2026-03-25

## Evidence

- timestamp: 2026-03-25
  checked: treeStore.ts createNode (line 387)
  found: `createNodeIpc(parentId, position, 'note', emptyContent, null, '')` - passes empty string '' as contentText
  implication: Every newly created node has content_text='' in the DB. The FTS5 INSERT trigger fires with empty string. The node is indexed but with empty text - so any query will never match it.

- timestamp: 2026-03-25
  checked: treeStore.ts updateContent (line 493)
  found: `await updateNodeIpc(id, content, null, null, null, text)` where text = extractText(content). This IS called with actual text on every edit (after 300ms debounce).
  implication: content_text gets populated only when the user types something and the debounce fires. After typing, the FTS5 UPDATE trigger fires, deleting the old empty FTS5 entry and inserting the new one with actual text. This path works correctly.

- timestamp: 2026-03-25
  checked: nodes.rs update_node (lines 184-186)
  found: Dynamic SQL builder only adds `content_text = ?7` to SET clause when content_text is Some(). The binding order is ?1=now, ?2=content_str, ?3=position, ?4=collapsed, ?5=metadata, ?6=id, ?7=content_text.
  implication: content_text update is correctly conditional and correctly bound. No bug here.

- timestamp: 2026-03-25
  checked: FTS5 UPDATE trigger in 0002_search_and_editing.sql (lines 31-34)
  found: The trigger runs on AFTER UPDATE ON nodes - this fires even when only position/collapsed/metadata changes, NOT content_text. When updateNodeIpc is called with content_text=null (e.g. toggleNode collapse), the trigger fires and re-indexes with whatever content_text was already in the row - so no data loss there.
  implication: Trigger is fine for existing data. The core issue remains that nodes created via createNode start with content_text=''.

- timestamp: 2026-03-25
  checked: extractText in tree.ts (lines 16-41)
  found: extractText walks ProseMirror JSON and extracts text node values. Called in treeStore.ts updateContent as `const text = extractText(content)`.
  implication: The extraction function itself is correct. The problem is that it's only called during updateContent, not during createNode. At create time, the empty ProseMirror doc `{ type: 'doc', content: [{ type: 'paragraph' }] }` has no text nodes, so extractText would return '' anyway - this is expected behavior for a brand new blank node.

- timestamp: 2026-03-25
  checked: FTS5 prefix query construction in search.rs (line 47)
  found: `format!("\"{}\"*", trimmed.replace('"', "\"\""))` - wraps term in double-quotes then appends *. This creates a phrase query like `"hello"*` which in FTS5 means prefix match on the phrase "hello". This is valid FTS5 syntax.
  implication: The query format is correct.

- timestamp: 2026-03-25
  checked: nodes_fts CREATE VIRTUAL TABLE (migration 0002, lines 13-18)
  found: `content='nodes', content_rowid='rowid'` - this is FTS5 external content mode. In this mode, FTS5 does NOT store content itself; it only stores the index. The actual content is read from the `nodes` table when needed (for snippet() calls). The sync is maintained entirely by the three triggers.
  implication: External content mode means if the triggers ever fail to fire or fire with wrong data, the index silently diverges from the table. There is no automatic re-sync.

## Resolution

root_cause: |
  There are TWO compounding problems that together cause search to return no results:

  PRIMARY BUG - FTS5 external content mode + no backfill on migration:
  The nodes_fts virtual table is created in external content mode (content='nodes'). When migration 0002 runs on an existing database that already has rows in the `nodes` table, the FTS5 index is EMPTY - it only indexes nodes created AFTER the migration runs, via the triggers. Any nodes that existed before the migration are invisible to search. Since the app was likely used before this migration was added, all existing nodes are not indexed.

  SECONDARY BUG - content_text is always empty at create time:
  In treeStore.ts line 387, createNode passes '' (empty string) as contentText. The INSERT trigger fires and indexes an empty string. So even NEW nodes (created after migration 0002) are indexed with empty content_text=''. They only get real text in the FTS5 index after the user types something and the 300ms debounce fires, triggering updateNodeIpc with actual text. A brand-new node that a user creates but never edits (just navigates away) will always return no results.

  For nodes the user HAS typed content into: the updateContent debounce (300ms) calls updateNodeIpc with the extracted text, which fires the FTS5 UPDATE trigger and indexes the real content. So for these nodes, search SHOULD work - unless they existed before the migration ran.

  BOTTOM LINE: For any app instance where nodes were created before migration 0002 was applied, ALL of those nodes are invisible in search because the FTS5 index was never backfilled. The missing backfill statement would be:
  `INSERT INTO nodes_fts(rowid, content_text) SELECT rowid, content_text FROM nodes;`
  This line is absent from migration 0002_search_and_editing.sql.

fix: (not applied - diagnosis only)
verification: (not applied - diagnosis only)
files_changed: []
