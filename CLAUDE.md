# CLAUDE.md

> The project was renamed **ai-chat → Forage** (bundle id `com.forage.app`). Historical references to `ai-chat` in `.planning/` and older ADRs are intentional. See ADR-0010.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # installs all workspaces + desktop sidecar deps
npm run dev              # PostgreSQL + migrations, then API + real Tauri app via Turbo
npm run dev:desktop      # Real local-only Tauri app; no PostgreSQL or API
npm run dev:server       # PostgreSQL + migrations + API only
npm run server:bootstrap # One-time local owner, outline, and credential creation
npm run dev:down         # Stop local compose infrastructure
npm run dev:web --workspace @forage/desktop   # Browser-only Vite frontend on :1420
npm run build            # Turbo build/typecheck for desktop and server
npm run tauri -- build   # Bundle the macOS app
npm test                 # root Vitest suite (setup: apps/desktop/src/test-setup.ts)
npx vitest run apps/desktop/src/path/to/file.test.ts  # single test file
npx vitest run -t "test name"                  # single test by name
npm run typecheck --workspace @forage/server   # server typecheck only
```

Prerequisites: Node.js 18+, Codex 0.148.0+ (subscription image generation only).
The sidecar runs via `tsx` with its own npm dependencies in `apps/desktop/src-tauri/resources/pi/sidecar/`;
`npm install` at root handles both the webview and sidecar in one step.

There is no linter. `tsconfig.json` is strict and has `noUnusedLocals`/`noUnusedParameters`, so `tsc` is the gate.

Anything touching custom native persistence/sync commands or `plugin-store` only works in the Tauri app (`npm run dev` or `npm run dev:desktop`), not the browser-only `dev:web` command.

## Architecture

Tauri v2 desktop shell around a TypeScript/React frontend, with narrow custom Rust commands for SQLite durability, content-addressed assets, OS credentials, and pinned server transport. Shared domain/document/protocol behavior lives in TypeScript packages and the optional Node.js server uses PostgreSQL.

Four things carry the design:

**One TipTap document is the entire outline.** `apps/desktop/src/editor/OutlinerEditor.tsx` mounts a single editor; text bullets are ProseMirror `listItem`s, generated images are image-only `generatedImageItem`s, and nesting is real document nesting. Durable document events contain forward/inverse ProseMirror steps; undo and redo append compensating events. Do not reintroduce per-node editors or authoritative per-bullet database rows.

**Bullet identity comes from a ProseMirror plugin, not from the store.** `apps/desktop/src/editor/extensions.ts` `BulletAttributes` adds `nodeId`/`nodeType` global attributes to `listItem` and assigns a UUID to any listItem lacking one (or holding a duplicate) via `appendTransaction`, so ids land in the same history step as the edit that created them. `nodeType: 'ai'` marks agent-written bullets (styled via `data-node-type` in `apps/desktop/src/style.css`).

**Persistence is an SQLite event store in application data.** `apps/desktop/src-tauri/src/persistence.rs` owns immediate transactional append, checkpoints, the pending outbox, acknowledgements, and explicit local/server mode. Local mode is single-device. In server mode, PostgreSQL is authoritative and SQLite remains the offline cache/outbox. iCloud persistence and legacy migration were removed; see ADR-0012.

**Generated images are content-addressed assets.** Documents store `assetId` plus alt text, never data URLs or paths. Rust verifies and caches local bytes. Server mode uploads/downloads through authenticated native commands; the server verifies signature, size, hash, ownership, and completion before accepting a referencing event.

**Agent work runs in a Node.js SDK sidecar.** `apps/desktop/src/agent/piSdkClient.ts` spawns `node` (via `tsx`) running `apps/desktop/src-tauri/resources/pi/sidecar/index.ts` with the Pi SDK (`@earendil-works/pi-coding-agent`) embedded directly. `apps/desktop/src-tauri/resources/pi/sidecar/tools.ts` registers all tools (`web_search`, `web_fetch`, `generate_image`, `emit_outline`, `search_outline`, custom HTTP); `apps/desktop/src-tauri/resources/pi/sidecar/codex-image-generation.ts` handles isolated Codex app-server image generation. Codex credentials from `plugin-store` are passed through the child environment, never process arguments. Communication is JSONL over stdin/stdout using the same event vocabulary the frontend already expects.

This replaced the earlier `pi --mode rpc` + bridge extension design (`piRpcClient.ts`, `ai-chat-bridge.ts` — still on disk, only referenced by tests). The SDK sidecar removes the `pi` CLI dependency; the only runtime requirement is Node.js 18+.

### Agent flow

`SlashMenu` (`apps/desktop/src/components/Agent/SlashMenu.tsx`) opens only when the current bullet's text *starts* with `/` — this is deliberate (no false positives on mid-sentence slashes). Picking a skill completes `/skill ` so the user can type a prompt and add stable internal links with `[[`. On Enter, `runSkillIntoEditor` (`apps/desktop/src/agent/insertIntoEditor.ts`):

1. resolves the full ancestor path plus the invocation's complete parent branch, excluding the invocation subtree and unrelated higher-level sibling branches, then adds explicitly linked branches in reference appearance order,
2. blocks missing references or context over the fixed 100-node/40,000-character safety budget before inserting output,
3. inserts an empty child bullet with `nodeType: 'ai'` and removes only the slash prefix, preserving structured links in the prompt,
4. sends the skill instructions, prompt, and indentation-preserving context sections through the SDK sidecar over JSONL IPC,
5. applies `emit_outline` tool results as nested bullets (or streamed text as a fallback); generated images become separate `generatedImageItem` outline nodes rather than content appended to text `listItem`s, with each write using `tr.setMeta('addToHistory', false)`,
6. writes `[cancelled]` into the same bullet on abort; on failure it removes the generated branch and shows the error in a dismissible popup.

Agents and slash-command skills are typed definitions in `apps/desktop/src/agent/definitions.ts`, persisted by `apps/desktop/src/store/settingsStore.ts`, and configurable in Settings. An agent controls instructions, model override, and a tool allowlist; a skill controls its slash label, workflow instructions, and assigned agent. Context selection is not skill-configurable: command placement supplies the ancestor path and local parent branch, while structured stable-ID links are the only external-context mechanism. `apps/desktop/src/agent/context.ts` resolves and bounds both sections, while `apps/desktop/src/editor/contextPreview.ts` highlights local, referenced, excluded invocation, and error states ephemerally. The sidecar exposes only globally enabled tools that the selected agent also allows. In subscription mode, `generate_image` starts an isolated ephemeral Codex app-server with externally managed ChatGPT tokens, external tools disabled, and read-only sandboxing, so GPT Image 2 usage counts against Codex limits. In API-key mode it calls the billed OpenAI Images API directly. Development therefore requires Node.js 18+ and `codex` on `PATH` (for subscription image generation only).

### Persistence and server checks

`cargo test` under `apps/desktop/src-tauri/` covers SQLite, native origin pinning, and local assets. Server unit/API tests run with the root Vitest suite. PostgreSQL contract tests require `podman compose up -d postgres` and access to `127.0.0.1:55437`.

## Planning workflow (GSD)

`.planning/` holds the GSD workflow state used to drive this project: `PROJECT.md` (requirements, constraints, key decisions), `ROADMAP.md`, `STATE.md`, and per-phase plans in `.planning/phases/`.

Read `ROADMAP.md` before large changes. It records a **2026-06-08 re-platform**: the original 6-phase Rust/SQLite/Node-sidecar roadmap was abandoned (too costly across 6 layer seams) in favor of 3 phases — A (outliner), B (agent), C (polish + signed .dmg). Phase 1-6 detail below the marker is superseded history; requirement codes referenced in code comments (`AGNT-01`, `EDIT-04`, `INFR-03`, …) map to `REQUIREMENTS.md`.
