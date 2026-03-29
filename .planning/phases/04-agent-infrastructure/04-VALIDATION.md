---
phase: 4
slug: agent-infrastructure
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-29
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (frontend), cargo test (backend) |
| **Config file** | vitest.config.ts, src-tauri/Cargo.toml |
| **Quick run command** | `npx vitest run --reporter=verbose 2>&1 | tail -20` |
| **Full suite command** | `npx vitest run && cd src-tauri && cargo test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx tsc --noEmit && cd src-tauri && cargo check`
- **After every plan wave:** Run `npx vitest run && cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | INFR-01 | integration | `cargo test test_settings` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | AGNT-01 | integration | `npx vitest run sidecar` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | AGNT-02 | unit | `npx vitest run slash` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | AGNT-03 | integration | `npx vitest run context` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Test stubs for sidecar RPC communication
- [ ] Test stubs for slash command TipTap extension
- [ ] Test stubs for settings/API key management

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Streaming token display | AGNT-03 | Real-time visual streaming requires running app | Trigger /ask, observe tokens appearing progressively |
| Escape cancels generation | AGNT-03 | Keyboard interaction with streaming state | Trigger /ask, press Escape during streaming |
| Slash autocomplete UX | AGNT-02 | TipTap popup rendering | Type '/' in editor, observe dropdown |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
