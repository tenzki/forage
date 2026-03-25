---
phase: 03
slug: search-and-editing
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-25
---

# Phase 03 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.1.1 (frontend) + Rust integration tests (cargo test) |
| **Config file** | vite.config.ts (implied via package.json test script) |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm test && cargo test --test db_tests -- --test-threads=1` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test`
- **After every plan wave:** Run `npm test && cargo test --test db_tests -- --test-threads=1`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | TREE-05 | integration (Rust) | `cargo test --test db_tests test_search_nodes -- --test-threads=1` | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 1 | TREE-05 | unit (React) | `npm test -- SearchOverlay` | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 1 | EDIT-01 | integration (Rust) | `cargo test --test db_tests test_undo_redo -- --test-threads=1` | ❌ W0 | ⬜ pending |
| 03-02-02 | 02 | 1 | EDIT-01 | unit (Zustand) | `npm test -- undoGrouping` | ❌ W0 | ⬜ pending |
| 03-03-01 | 03 | 2 | EDIT-02 | unit (TipTap) | `npm test -- markFormatting` | ❌ W0 | ⬜ pending |
| 03-03-02 | 03 | 2 | EDIT-03 | unit (TipTap) | `npm test -- HashtagNode` | ❌ W0 | ⬜ pending |
| 03-03-03 | 03 | 2 | EDIT-03 | integration (Rust) | `cargo test --test db_tests test_tag_indexing -- --test-threads=1` | ❌ W0 | ⬜ pending |
| 03-03-04 | 03 | 2 | EDIT-04 | unit (React) | `npm test -- Bullet` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/tests/db_tests.rs` — extend with: `test_search_nodes`, `test_undo_redo`, `test_tag_indexing`
- [ ] `src/components/Search/SearchOverlay.test.tsx` — Cmd+K open/close, keyboard navigation
- [ ] `src/extensions/HashtagNode.test.tsx` — node insertion, JSON round-trip
- [ ] `src/components/Outliner/Bullet.test.tsx` — sparkle icon for agent_response
- [ ] `src/utils/undoGrouping.test.ts` — 1s gap grouping logic

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Cmd+K overlay visual appearance | TREE-05 | CSS/visual verification | Open app, press Cmd+K, verify centered overlay with search input |
| Hashtag autocomplete dropdown | EDIT-03 | Interactive UI behavior | Type `#` in a node, verify dropdown appears with existing tags |
| AI sparkle icon rendering | EDIT-04 | Visual styling verification | Create agent_response node via DB, verify sparkle replaces bullet |
| Tag sidebar toggle and counts | EDIT-03 | Layout/interaction | Click sidebar toggle, verify tag list with counts appears |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
