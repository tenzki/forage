---
phase: 04-agent-infrastructure
plan: 01
subsystem: infra
tags: [nodejs, sidecar, tauri-plugin-shell, aes-256-gcm, jsonl, rpc, rust, keystore]

requires:
  - phase: 01-storage-foundation
    provides: AppState/SqlitePool pattern, Tauri setup/plugin wiring conventions
  - phase: 03-search-and-editing
    provides: agent_response node_type (sparkle icon already in tree)

provides:
  - Node.js sidecar project at src-sidecar/ with JSONL RPC bridge
  - AES-256-GCM encrypted settings storage (keystore.ts)
  - Rust agent commands: spawn_sidecar, agent_command, kill_sidecar, save_settings, get_settings
  - SidecarState (tokio Mutex<Option<CommandChild>>) managed in Tauri
  - Tauri shell capabilities: allow-spawn (ai-sidecar), allow-stdin-write, allow-kill
  - tauri.conf.json externalBin declaration for ai-sidecar

affects:
  - 04-02 (settings page — calls get_settings/save_settings via agent-event channel)
  - 04-03 (slash commands — uses agent_command to dispatch prompt)
  - 04-04 (pi-coding-agent integration — extends index.ts prompt handler)

tech-stack:
  added:
    - tauri-plugin-shell (already in Cargo.toml, now registered in Builder)
    - @mariozechner/pi-coding-agent (sidecar dep, placeholder for Plan 04)
    - Node.js crypto (built-in, AES-256-GCM)
    - Node.js test runner (built-in, keystore unit tests)
  patterns:
    - JSONL stdin/stdout RPC bridge between Rust and Node.js sidecar
    - Fire-and-forget IPC commands with async response via agent-event Tauri event
    - AES-256-GCM: iv(12) + authTag(16) + ciphertext binary format
    - Agent commands excluded from tauri-specta collect_commands (use generate_handler! instead)

key-files:
  created:
    - src-sidecar/package.json
    - src-sidecar/tsconfig.json
    - src-sidecar/keystore.ts
    - src-sidecar/keystore.test.ts
    - src-sidecar/index.ts
    - src-tauri/src/commands/agent.rs
    - src-tauri/capabilities/default.json
    - src-tauri/binaries/ai-sidecar-aarch64-apple-darwin
  modified:
    - src-tauri/src/commands/mod.rs
    - src-tauri/src/lib.rs
    - src-tauri/tauri.conf.json

key-decisions:
  - "Agent commands excluded from tauri-specta collect_commands! — tauri::State and AppHandle don't derive Specta; registered directly in tauri::generate_handler! instead"
  - "app_handle captured before block_on async move — init_db takes &tauri::App which moves into async; app_handle cloned first for post-setup sidecar spawn"
  - "try_state used in Terminated handler — AppHandle doesn't have Manager in scope unless imported; try_state avoids unwrap panic if state not yet managed"
  - "Placeholder binary ai-sidecar-aarch64-apple-darwin — Tauri build script requires externalBin file to exist at build time; real pkg binary added in Plan 04"
  - "rewriteRelativeImportExtensions in tsconfig — NodeNext module resolution requires .ts extension in imports; this flag rewrites to .js in output"

patterns-established:
  - "Pattern: Sidecar fire-and-forget IPC — save_settings/get_settings write JSONL to stdin and return immediately; actual response arrives via agent-event Tauri event"
  - "Pattern: SidecarState with tokio::Mutex<Option<CommandChild>> — async command handlers require tokio Mutex; Option allows None-check for not-running guard"
  - "Pattern: JSONL line format — JSON.stringify(cmd) + \\n on both Rust write side and Node.js readline side; never CRLF"

requirements-completed: [INFR-01]

duration: 5min
completed: 2026-03-29
---

# Phase 04 Plan 01: Agent Infrastructure Scaffold Summary

**Node.js sidecar JSONL RPC bridge with AES-256-GCM keystore, Rust spawn/command/kill bridge, and Tauri shell capabilities wired for ai-sidecar**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-29T06:58:03Z
- **Completed:** 2026-03-29T07:03:11Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- Created src-sidecar/ as a separate Node.js/TypeScript project with JSONL stdin/stdout RPC bridge supporting ping, get_settings, save_settings, summarize (with Anthropic/OpenAI/Google provider dispatch), and prompt (placeholder)
- Implemented AES-256-GCM keystore with 12 passing unit tests covering round-trip, tamper rejection, missing-file empty-return, and key persistence
- Wired 5 Rust commands (spawn_sidecar, agent_command, kill_sidecar, save_settings, get_settings) with SidecarState managed in Tauri; sidecar spawned on app startup with stdout forwarded to agent-event Tauri event

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Node.js sidecar project with keystore and RPC entry point** - `ef52af6` (feat)
2. **Task 2: Wire Rust sidecar bridge commands and Tauri shell capabilities** - `93a6e28` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `src-sidecar/package.json` - ai-sidecar project, pi-coding-agent dependency
- `src-sidecar/tsconfig.json` - ES2022, NodeNext, rewriteRelativeImportExtensions
- `src-sidecar/keystore.ts` - AES-256-GCM encrypt/decrypt, file-based key management
- `src-sidecar/keystore.test.ts` - 12 unit tests using Node.js built-in test runner
- `src-sidecar/index.ts` - JSONL RPC entry point, summarize with provider dispatch
- `src-tauri/src/commands/agent.rs` - SidecarState + 5 Tauri commands
- `src-tauri/capabilities/default.json` - Shell permissions for ai-sidecar
- `src-tauri/tauri.conf.json` - externalBin: binaries/ai-sidecar added
- `src-tauri/src/commands/mod.rs` - pub mod agent added
- `src-tauri/src/lib.rs` - shell plugin, SidecarState managed, sidecar spawned on startup
- `src-tauri/binaries/ai-sidecar-aarch64-apple-darwin` - placeholder binary for build

## Decisions Made
- Agent commands excluded from tauri-specta `collect_commands!` — `tauri::State` and `AppHandle` don't derive Specta; registered directly in `tauri::generate_handler!` instead. This keeps existing bindings.ts generation working.
- `app_handle` captured before `block_on(async move { ... })` — `init_db` takes `&tauri::App` which moves into the async block; `app_handle` must be cloned before that for the sidecar spawn.
- Placeholder binary at `binaries/ai-sidecar-aarch64-apple-darwin` required — Tauri build script validates `externalBin` paths at compile time. Real `pkg` binary will be generated in Plan 04.
- `rewriteRelativeImportExtensions: true` in tsconfig — NodeNext module resolution requires `.ts` extensions in source imports; this flag rewrites them to `.js` in compiled output without requiring `noEmit: true`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added placeholder binary for Tauri externalBin build validation**
- **Found during:** Task 2 (Rust build)
- **Issue:** Tauri build script fails with "resource path doesn't exist" when externalBin is declared but binary not present
- **Fix:** Created empty placeholder at `src-tauri/binaries/ai-sidecar-aarch64-apple-darwin` with execute permission
- **Files modified:** src-tauri/binaries/ai-sidecar-aarch64-apple-darwin
- **Verification:** cargo build passes
- **Committed in:** 93a6e28 (Task 2 commit)

**2. [Rule 1 - Bug] Fixed app_handle capture before async move**
- **Found during:** Task 2 (Rust compilation)
- **Issue:** `app` moved into `block_on(async move {...})` for `init_db`, then borrowed for `app.handle()` after move
- **Fix:** Captured `app_handle_for_sidecar = app.handle().clone()` before the block_on call
- **Files modified:** src-tauri/src/lib.rs
- **Verification:** Rust compiles cleanly
- **Committed in:** 93a6e28 (Task 2 commit)

**3. [Rule 1 - Bug] Agent commands excluded from specta builder**
- **Found during:** Task 2 (Rust compilation)
- **Issue:** `tauri::State<SidecarState>` parameters cause specta `collect_commands!` macro errors — those types don't implement Specta's type export
- **Fix:** Kept agent commands only in `tauri::generate_handler!`, not in `tauri_specta::collect_commands!`
- **Files modified:** src-tauri/src/lib.rs
- **Verification:** Rust compiles cleanly, all commands registered
- **Committed in:** 93a6e28 (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking, 2 bugs)
**Impact on plan:** All fixes necessary for compilation correctness. No scope creep.

## Issues Encountered
- tsconfig needed `rewriteRelativeImportExtensions: true` for NodeNext `.ts` imports — not in original plan spec but required for the specified module format to compile

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Sidecar lifecycle infrastructure complete: spawn on startup, JSONL IPC, stdout forwarded to agent-event
- Keystore ready for Plan 02 (settings page) to save/load API keys via get_settings/save_settings
- agent_command IPC ready for Plan 03 (slash commands) to dispatch prompt commands
- Real pkg binary compilation and Plan 04 pi-coding-agent integration are next steps

---
*Phase: 04-agent-infrastructure*
*Completed: 2026-03-29*

## Self-Check: PASSED

- All 8 expected files: FOUND
- Commit ef52af6 (Task 1): FOUND
- Commit 93a6e28 (Task 2): FOUND
