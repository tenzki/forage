# Forage
Forage is a second brain note taker with customizable agents. Powered by [Pi](https://pi.dev).
![Forage overview](docs/images/forage-overview.png)

## Features

- **One outline, real nesting** — the entire document is a single TipTap editor. Undo/redo is native and works across any edit, including agent output.
- **Keyboard-first navigation** — Tab/Shift-Tab to indent, Enter for siblings, Alt-Arrow to move branches, plus zoom/hoist into any bullet, drag-reorder, and search.
- **Slash-command skills** — start a bullet with `/` to invoke a skill:
  - `/research <topic>` — investigate a topic and structure findings as child notes
  - `/brainstorm <prompt>` — generate ideas and options for the current note
  - `/ask <question>` — ask the agent about the current branch
  - `/image <prompt>` — generate an image under the current bullet (via Codex or the OpenAI Images API)
- **Bi-directional links** — type `[[` to link any bullet to any other via stable IDs: click to jump, and a backlinks panel shows everything that references the current bullet. Links survive reordering and nesting, and linked branches can be pinned as explicit agent context.
- **Your notes as agent memory** — every skill invocation automatically carries the bullet's full ancestry and branch, and agents can search your whole outline (`search_outline`) before writing, so answers build on what you already know instead of duplicating it.
- **Extensible agents and skills** — every agent and slash-command skill is a typed definition you can edit in Settings (Cmd+,): model, instructions, and a per-agent tool allowlist. Add custom HTTP tools, new skills, whole new agents, or explicitly trusted local extensions.
- **Optional unattended server execution** — in server storage mode, manual skills and opt-in Inbox link policies run durably on the self-hosted server, including bounded webpage/X reading and replaceable YouTube transcription.
- **Tags, shortcuts, and trash** — tag bullets, pin frequently used branches to the sidebar, and recover deleted branches from trash.

## Requirements

- Node.js 18+
- pnpm 10.32.1 (the repository's `packageManager` pin can be activated with Corepack)
- Rust toolchain (Tauri build) — install via [rustup](https://rustup.rs/) if missing

Optional:

- [Codex CLI](https://github.com/openai/codex) 0.148.0+ on `PATH` — needed only for subscription-mode image generation (`/image`). API-key image generation and all other features work without it.

## Run it

```bash
pnpm install   # installs all workspace and agent-sidecar dependencies
pnpm dev       # starts PostgreSQL, applies migrations, then runs the API and Tauri app
```

On a fresh development database, run `pnpm server:bootstrap` once before connecting the desktop to the server. It prints the initial credentials exactly once; the first desktop then seeds the server with its outline. To work only on the local-first desktop app without PostgreSQL or the API, use `pnpm dev:desktop`. For server connection, tokens, and the Notes API, see [Optional Server Backend](docs/server-backend.md).


## Built on Pi

Forage follows [Pi](https://pi.dev)'s philosophy of agents as small, inspectable systems: explicit skills and tool permissions, user-owned model access, and structured results that stay in your outline. Agents should be configurable and understandable, not a black-box prompt wrapper.

## Architecture

See [Forage Architecture](docs/architecture.md) for the current component, authority, storage-mode, and agent-execution map.

## Extension development

Forage has a native extension manifest and host API inspired by Pi's registration style without using Pi's extension format. Start with the [Extensions guide](docs/extensions.md), [`@forage/extension-api`](packages/extension-api/README.md), and the [runnable reference extension](packages/extensions/README.md).
