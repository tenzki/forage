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

Tauri v2 desktop shell around a TypeScript/React frontend. **All app logic lives in TypeScript.** `src-tauri/src/lib.rs` only registers official plugins (fs, store, http, opener, shell) — no custom Rust commands, no custom IPC layer, no database.

Four things carry the design:

**One TipTap document is the entire outline.** `src/editor/OutlinerEditor.tsx` mounts a single editor; text bullets are ProseMirror `listItem`s, generated images are image-only `generatedImageItem`s, and nesting is real document nesting. Undo/redo is ProseMirror's native history. This replaced an earlier per-node-editor + SQLite + Rust-undo-table design that had unfixable undo bugs — do not reintroduce per-node editors or an external undo stack.

**Bullet identity comes from a ProseMirror plugin, not from the store.** `src/editor/extensions.ts` `BulletAttributes` adds `nodeId`/`nodeType` global attributes to `listItem` and assigns a UUID to any listItem lacking one (or holding a duplicate) via `appendTransaction`, so ids land in the same history step as the edit that created them. `nodeType: 'ai'` marks agent-written bullets (styled via `data-node-type` in `src/style.css`).

**Persistence is one JSON file in iCloud Drive.** `src/persistence/outlineFile.ts` writes `{version: 1, doc}` to `~/Library/Mobile Documents/com~apple~CloudDocs/AIChat/tree.json`; macOS handles sync. `App.tsx` owns the debounced saver (600ms) and flushes on `beforeunload`. **The fs scope in `src-tauri/capabilities/default.json` must allow any path you read/write** — writes outside it fail at runtime, not compile time.

**Agent work runs in a Pi RPC subprocess.** `src/agent/piRpcClient.ts` launches `pi --mode rpc` through the official shell plugin with automatic resources and built-in tools disabled. `src-tauri/resources/pi/ai-chat-bridge.ts` is the only explicitly loaded extension; it applies app agent instructions and exposes structured `emit_outline` output. Codex credentials from `plugin-store` are passed through the child environment, never process arguments. Subscription image generation delegates to an isolated Codex app-server child. Development currently requires `pi` and `codex` on `PATH`; bundling pinned runtimes is still required for distribution.

### Agent flow

`SlashMenu` (`src/components/Agent/SlashMenu.tsx`) opens only when the current bullet's text *starts* with `/` — this is deliberate (no false positives on mid-sentence slashes). Picking a skill completes `/skill ` so the user can type a prompt and add stable internal links with `[[`. On Enter, `runSkillIntoEditor` (`src/agent/insertIntoEditor.ts`):

1. resolves the full ancestor path plus the invocation's complete parent branch, excluding the invocation subtree and unrelated higher-level sibling branches, then adds explicitly linked branches in reference appearance order,
2. blocks missing references or context over the fixed 100-node/40,000-character safety budget before inserting output,
3. inserts an empty child bullet with `nodeType: 'ai'` and removes only the slash prefix, preserving structured links in the prompt,
4. sends the skill instructions, prompt, and indentation-preserving context sections through Pi RPC using `/ai-chat-run`,
5. applies `emit_outline` tool results as nested bullets (or streamed text as a fallback); generated images become separate `generatedImageItem` outline nodes rather than content appended to text `listItem`s, with each write using `tr.setMeta('addToHistory', false)`,
6. writes `[cancelled]` / `[error: …]` into the same bullet on abort/failure.

Agents and slash-command skills are typed definitions in `src/agent/definitions.ts`, persisted by `src/store/settingsStore.ts`, and configurable in Settings. An agent controls instructions, model override, and a tool allowlist; a skill controls its slash label, workflow instructions, and assigned agent. Context selection is not skill-configurable: command placement supplies the ancestor path and local parent branch, while structured stable-ID links are the only external-context mechanism. `src/agent/context.ts` resolves and bounds both sections, while `src/editor/contextPreview.ts` highlights local, referenced, excluded invocation, and error states ephemerally. The bridge exposes only globally enabled tools that the selected agent also allows. In subscription mode, `generate_image` starts an isolated ephemeral Codex app-server with externally managed ChatGPT tokens, external tools disabled, and read-only sandboxing, so GPT Image 2 usage counts against Codex limits. In API-key mode it calls the billed OpenAI Images API directly. Development therefore requires both `pi` and `codex` on `PATH`.

### Stale files — ignore, don't build on

`src-tauri/migrations/*.sql` and `src-tauri/tests/db_tests.rs` are leftovers from the pre-re-platform SQLite backend. `Cargo.toml` no longer depends on `sqlx`, so `cargo test` in `src-tauri/` does not compile. Delete rather than revive them if they get in the way.

## Planning workflow (GSD)

`.planning/` holds the GSD workflow state used to drive this project: `PROJECT.md` (requirements, constraints, key decisions), `ROADMAP.md`, `STATE.md`, and per-phase plans in `.planning/phases/`.

Read `ROADMAP.md` before large changes. It records a **2026-06-08 re-platform**: the original 6-phase Rust/SQLite/Node-sidecar roadmap was abandoned (too costly across 6 layer seams) in favor of 3 phases — A (outliner), B (agent), C (polish + signed .dmg). Phase 1-6 detail below the marker is superseded history; requirement codes referenced in code comments (`AGNT-01`, `EDIT-04`, `INFR-03`, …) map to `REQUIREMENTS.md`.
