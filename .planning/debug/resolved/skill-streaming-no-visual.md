---
status: fixing
trigger: "Slash commands invoke and work on the backend, but there is NO visual indication — no streaming text, no loading animation, no ghost node, nothing visible."
created: 2026-03-29T00:00:00Z
updated: 2026-03-29T00:00:00Z
---

## Current Focus

hypothesis: invokeSkill creates the ghost node in the DB but never inserts it into the in-memory tree state, so NodeRow never renders it and appendToken's updateNodeLocally silently no-ops.
test: Read every step of invokeSkill, createNodeIpc return value usage, and insertNodeInTree calls
expecting: confirmed — no insertNodeInTree or loadTree call after ghost node creation
next_action: insert ghost TreeNode into treeStore immediately after createNodeIpc returns

## Symptoms

expected: ghost child node appears under the triggering node with pulse animation; tokens stream in visually as they arrive
actual: nothing visible — no ghost node, no animation, no streamed text
errors: none (backend works, sidecar processes the request, DB has the ghost node)
reproduction: type "/ask what year is it?" in any node, press Enter
started: always broken (feature not yet wired to tree)

## Eliminated

- hypothesis: initAgentListener not called on mount
  evidence: OutlinerView.tsx line 103 calls it correctly in useEffect; listener IS registered
  timestamp: 2026-03-29

- hypothesis: agent-event not reaching frontend
  evidence: backend works per objective; sidecar emits events; listener processes them
  timestamp: 2026-03-29

- hypothesis: appendToken broken
  evidence: appendToken calls updateNodeLocally correctly, BUT the ghost node doesn't exist in tree state so updateNodeInTree finds nothing and silently no-ops. Root issue is upstream.
  timestamp: 2026-03-29

- hypothesis: CSS animation missing
  evidence: .node-generating class and @keyframes node-pulse are both defined in style.css; NodeRow applies the class when isGenerating is true. But since ghost node is never in tree, NodeRow is never rendered for it.
  timestamp: 2026-03-29

## Evidence

- timestamp: 2026-03-29
  checked: agentStore.ts invokeSkill (lines 296-341)
  found: after createNodeIpc returns ghostNode, code stores it in activeGenerations map and calls agentCommandIpc — but NEVER calls insertNodeInTree or loadTree or updateNodeLocally to add the ghost to the visible tree
  implication: ghost node exists in DB but is invisible; all subsequent appendToken/updateNodeLocally calls for it are no-ops

- timestamp: 2026-03-29
  checked: treeStore.ts updateNodeLocally (line 808-810)
  found: calls updateNodeInTree which walks nodes array; if node not present, returns unmodified tree silently
  implication: confirms appendToken's updateNodeLocally is a no-op when ghost not in tree

- timestamp: 2026-03-29
  checked: NodeRow.tsx isGenerating check (lines 52-55)
  found: checks activeGenerations for ghostNodeId match — this logic is correct, but ghost node row never renders because tree has no such node
  implication: CSS class / animation never fires

- timestamp: 2026-03-29
  checked: treeStore.ts createNode (lines 361-412)
  found: uses insertNodeInTree after IPC — the pattern we need to replicate in invokeSkill for ghost node insertion
  implication: invokeSkill needs same pattern: get nodeToTreeNode(ghostNode), then insertNodeInTree into parent's children

## Resolution

root_cause: invokeSkill in agentStore.ts creates the ghost node in the DB via createNodeIpc but never inserts the resulting TreeNode into the in-memory treeStore.nodes array. Every downstream visual step (NodeRow render, node-generating class, appendToken updateNodeLocally) depends on the ghost node being present in the tree.

fix: After createNodeIpc returns ghostNode, convert it with nodeToTreeNode and insert it as first child of the triggering node using treeStore insertNodeInTree logic (via updateNodeLocally trick — actually need direct set on nodes). Use loadTree() as a simpler reliable alternative, but that loses the streaming visual. Best fix: insert ghost node directly using the same pattern as treeStore.createNode.

files_changed:
  - src/store/agentStore.ts
