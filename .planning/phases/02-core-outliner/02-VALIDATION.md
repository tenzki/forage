---
phase: 2
slug: core-outliner
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-24
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (frontend) + cargo test (backend additions) |
| **Config file** | vitest.config.ts (Wave 0 installs) |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run && cd src-tauri && cargo test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run && cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | TREE-01 | integration | `npx vitest run` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | TREE-02 | integration | `npx vitest run` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | TREE-03 | integration | `npx vitest run` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | TREE-04 | integration | `npx vitest run` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | TREE-06 | integration | `npx vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest` + `@testing-library/react` + `jsdom` — test framework setup
- [ ] `vitest.config.ts` — configuration file
- [ ] `src/__tests__/` — test directory
- [ ] `src-tauri/src/commands/nodes.rs` — add `move_node` IPC command (backend gap from Phase 1)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Keyboard feel & responsiveness | TREE-04 | Subjective typing feel | Create 50+ nodes, rapid key repeat on Enter/Tab/Arrow |
| Drag-and-drop visual feedback | TREE-06 | Visual indicator quality | Drag node across 3 depth levels, verify drop indicators |
| Zoom crossfade animation | TREE-03 | Visual animation quality | Zoom in/out 5 times, verify 150ms transition feels smooth |
| 1000+ node performance | TREE-01 | Performance perception | Load 1000 nodes, scroll/navigate without perceived lag |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
