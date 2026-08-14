# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Vite dev server on :1420 (browser — Tauri APIs unavailable)
npm run tauri dev        # Real app: launches the Tauri window (starts Vite itself)
npm run build            # tsc typecheck + vite build → dist/
npm run tauri build      # Bundle the macOS app
npm test                 # vitest run (jsdom, globals on, setup: src/test-setup.ts)
npx vitest run src/path/to/file.test.ts        # single test file
npx vitest run -t "test name"                  # single test by name
npx tsc --noEmit         # typecheck only
```

There is no linter. `tsconfig.json` is strict and has `noUnusedLocals`/`noUnusedParameters`, so `tsc` is the gate.

Anything touching `@tauri-apps/plugin-fs` or `plugin-store` (persistence, settings) only works under `npm run tauri dev`, not `npm run dev`.

## Architecture

Tauri v2 desktop shell around a TypeScript/React frontend. **All app logic lives in TypeScript.** `src-tauri/src/lib.rs` is ~12 lines that register two official plugins (fs, store) and nothing else — no custom Rust commands, no IPC layer, no database.

Four things carry the design:

**One TipTap document is the entire outline.** `src/editor/OutlinerEditor.tsx` mounts a single editor; bullets are ProseMirror `listItem`s and nesting is real document nesting. Undo/redo is ProseMirror's native history. This replaced an earlier per-node-editor + SQLite + Rust-undo-table design that had unfixable undo bugs — do not reintroduce per-node editors or an external undo stack.

**Bullet identity comes from a ProseMirror plugin, not from the store.** `src/editor/extensions.ts` `BulletAttributes` adds `nodeId`/`nodeType` global attributes to `listItem` and assigns a UUID to any listItem lacking one (or holding a duplicate) via `appendTransaction`, so ids land in the same history step as the edit that created them. `nodeType: 'ai'` marks agent-written bullets (styled via `data-node-type` in `src/style.css`).

**Persistence is one JSON file in iCloud Drive.** `src/persistence/outlineFile.ts` writes `{version: 1, doc}` to `~/Library/Mobile Documents/com~apple~CloudDocs/AIChat/tree.json`; macOS handles sync. `App.tsx` owns the debounced saver (600ms) and flushes on `beforeunload`. **The fs scope in `src-tauri/capabilities/default.json` must allow any path you read/write** — writes outside it fail at runtime, not compile time.

**LLM calls go straight from the webview to Anthropic.** `src/agent/client.ts` uses `@anthropic-ai/sdk` with `dangerouslyAllowBrowser: true` and the user's own key (stored by `plugin-store` via `src/store/settingsStore.ts`, file `settings.json`). No sidecar, no proxy, no server.

### Agent flow

`SlashMenu` (`src/components/Agent/SlashMenu.tsx`) opens only when the current bullet's text *starts* with `/` — this is deliberate (no false positives on mid-sentence slashes). Picking a skill replaces the `/skill …` text with the prompt, then `runSkillIntoEditor` (`src/agent/insertIntoEditor.ts`):

1. collects ancestor listItem texts as context (outer→inner),
2. inserts an empty child bullet with `nodeType: 'ai'`,
3. streams deltas into it, each write with `tr.setMeta('addToHistory', false)` so a whole generation collapses into one undo step,
4. writes `[cancelled]` / `[error: …]` into the same bullet on abort/failure.

Skills are a hardcoded array of `{label, description, systemPrompt}` in `src/agent/skills.ts` (a custom-skill config UI is explicitly deferred to v2).

### Stale files — ignore, don't build on

`src-tauri/migrations/*.sql` and `src-tauri/tests/db_tests.rs` are leftovers from the pre-re-platform SQLite backend. `Cargo.toml` no longer depends on `sqlx`, so `cargo test` in `src-tauri/` does not compile. Delete rather than revive them if they get in the way.

## Planning workflow (GSD)

`.planning/` holds the GSD workflow state used to drive this project: `PROJECT.md` (requirements, constraints, key decisions), `ROADMAP.md`, `STATE.md`, and per-phase plans in `.planning/phases/`.

Read `ROADMAP.md` before large changes. It records a **2026-06-08 re-platform**: the original 6-phase Rust/SQLite/Node-sidecar roadmap was abandoned (too costly across 6 layer seams) in favor of 3 phases — A (outliner), B (agent), C (polish + signed .dmg). Phase 1-6 detail below the marker is superseded history; requirement codes referenced in code comments (`AGNT-01`, `EDIT-04`, `INFR-03`, …) map to `REQUIREMENTS.md`.
