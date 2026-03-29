# Phase 04: Agent Infrastructure - Research

**Researched:** 2026-03-29
**Domain:** Node.js sidecar (pi-coding-agent RPC), Tauri v2 IPC/events, TipTap slash commands, encrypted secrets storage
**Confidence:** HIGH (primary sources verified)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Slash Command UX**
- Slash commands trigger anywhere in a node (not just start of line), via autocomplete dropdown (Notion/Slack style)
- User types '/' + characters, autocomplete suggests matching skills, selecting one triggers it
- Everything after the skill name is the inline argument/prompt (e.g., '/research quantum computing')
- The command text is stored in node metadata (not visible in node content) — the node appears clean but the prompt is recoverable
- No dialog/form for arguments — inline args only, keeping interaction fast and lightweight

**Streaming & Generation UX**
- Agent output streams token-by-token in real-time (SSE/streaming from sidecar to frontend)
- Skills can either replace the triggering node's content OR create 1 or multiple children — skill declares its output mode
- User can cancel active generation with Escape key
- Fully concurrent: user can edit other nodes while agent streams into a different node
- Generated nodes have node_type='agent_response' with sparkle icon (already implemented in Phase 3)

**Context & Conversation Model**
- Full ancestor chain from root to triggering node is sent as context
- Previous agent responses (node_type='agent_response') in the ancestor chain become assistant messages; user nodes become user messages — creates natural multi-turn conversation from tree structure
- When ancestor chain exceeds model context window, older ancestors are summarized (extra model call) while recent ones are kept in full
- Agent can only create new nodes — cannot read or modify existing nodes beyond what's in the sent context

**API Key Management**
- API keys stored in an encrypted local file in app data directory
- Multi-provider from start: Anthropic, OpenAI, Google (Gemini) — abstract provider interface
- Dedicated settings page accessible from gear icon for managing API keys (add/edit/delete per provider)
- Global default model in settings, with per-request override via flag (e.g., '/ask --model opus')

**Initial Skills**
- /ask — generic chat, sends context + prompt to model, creates child response node
- /research — deeper investigation, longer response, may create multiple child nodes
- /brainstorm — generates bullet-point ideas as multiple child nodes

### Claude's Discretion
- Sidecar architecture (Node.js process management, IPC protocol)
- Encrypted file format and encryption approach
- Autocomplete dropdown styling and positioning
- Streaming protocol between sidecar and frontend (SSE vs WebSocket vs Tauri events)
- Context summarization prompt design
- Exact skill system extensibility API

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INFR-01 | User can store and manage their own LLM API keys (OpenAI, Anthropic) | Tauri Stronghold plugin provides encrypted local vault; custom AES-256-GCM JSON file is simpler and sufficient for v1 |
| AGNT-01 | User can trigger agent actions via slash commands (e.g., `/research topic`) | TipTap `@tiptap/suggestion` (already installed) powers slash menu; same pattern as existing HashtagNode |
| AGNT-02 | Agent generates structured child notes using branch context (ancestors + siblings) | `get_ancestors` IPC already exists; pi RPC `prompt` command accepts context as system message or prior messages |
| AGNT-03 | Agent can generate inline content on the current node | Note: REQUIREMENTS.md maps AGNT-03 to Phase 5, not Phase 4. Phase 4 scope is INFR-01, AGNT-01, AGNT-02 per CONTEXT.md |
</phase_requirements>

---

## Summary

Phase 4 wires together four independent concerns: (1) a Node.js sidecar running pi-coding-agent in RPC mode, (2) Tauri IPC bridging frontend commands to Rust which manages sidecar stdin/stdout, (3) slash command autocomplete in TipTap, and (4) encrypted API key storage.

The pi-coding-agent package (`@mariozechner/pi-coding-agent` v0.58.3, March 2026) is a real, active npm package. Its RPC mode exposes a JSON-over-stdin/stdout protocol — exactly what a Tauri sidecar needs. The sidecar process stays alive for the app's lifetime; Rust spawns it on startup, holds the child handle, and forwards commands/events between the frontend and the sidecar. Frontend streaming arrives via Tauri's `app.emit()` event system.

The slash command implementation is a direct extension of the existing HashtagNode pattern. `@tiptap/suggestion` (already installed) supports `char: '/'`, `startOfLine: false`, and `allowSpaces: true` — triggering from anywhere in the line with spaces as part of the argument. For API key storage, the simplest correct approach for v1 is an AES-256-GCM encrypted JSON file written to the Tauri app-data directory. Tauri's Stronghold plugin exists but is heavier than necessary for this use case.

**Primary recommendation:** Use pi-coding-agent in RPC mode as the sidecar, Rust-managed stdin/stdout bridged to the frontend via `app.emit()`, TipTap suggestion extension for slash commands, and AES-256-GCM encrypted JSON file for API key storage.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@mariozechner/pi-coding-agent` | 0.58.3 (latest) | Agent runtime, multi-provider LLM, skills, streaming | Already decided; provides RPC mode, 15+ providers, streaming events |
| `tauri-plugin-shell` | matches Tauri v2 | Spawn/manage sidecar process, stdin/stdout IPC | Official Tauri plugin; only way to manage external processes in v2 |
| `@tiptap/suggestion` | ^3.20.5 (installed) | Slash command autocomplete popup | Already in project for HashtagNode; reuse exact same pattern |
| `aes-256-gcm` via Node.js `crypto` | Node built-in | Encrypt/decrypt API key store in sidecar | No external dep; authenticated encryption; used in the sidecar process |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@mariozechner/pi-ai` | latest | Unified LLM API (if pi-coding-agent not sufficient) | Only if RPC mode is insufficient; pi-coding-agent bundles this |
| `@tauri-apps/api/event` | 2.10.x (installed) | Frontend event listener for streaming tokens | Already installed; used for `listen()` to receive stream events |
| `vitest` | ^4.1.1 (installed) | Unit tests for sidecar protocol parsing, store actions | Already in project |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pi-coding-agent RPC | Vercel AI SDK (`ai` package) | Vercel AI is simpler but requires building skill system and session management from scratch; RPC gives these for free |
| pi-coding-agent RPC | Direct Anthropic/OpenAI/Google SDK calls | Each provider needs separate integration; pi-ai provides unified abstraction |
| AES-256-GCM JSON file | Tauri Stronghold plugin | Stronghold is being deprecated in v3; overkill for simple key storage; encryption-in-sidecar is simpler |
| AES-256-GCM JSON file | OS keychain (macOS Keychain, Windows Credential Manager) | Correct long-term approach but adds platform-specific Rust dependencies; v1 scope doesn't require it |

**Installation (sidecar build):**
```bash
# Frontend (already done)
# @tiptap/suggestion is already installed

# Tauri shell plugin
npm run tauri add shell

# Sidecar package.json (separate Node.js project in src-sidecar/)
npm install @mariozechner/pi-coding-agent
```

---

## Architecture Patterns

### Recommended Project Structure
```
src-sidecar/               # Node.js sidecar — separate npm project
├── package.json           # depends on @mariozechner/pi-coding-agent
├── tsconfig.json
├── index.ts               # Entry: starts pi in RPC mode, exposes JSON IPC layer
├── skills/
│   ├── ask.ts             # /ask skill definition
│   ├── research.ts        # /research skill definition
│   └── brainstorm.ts      # /brainstorm skill definition
└── keystore.ts            # AES-256-GCM encrypted JSON file operations

src-tauri/
├── binaries/
│   └── ai-sidecar-aarch64-apple-darwin  # compiled pkg binary
├── capabilities/
│   └── default.json       # shell:allow-spawn, shell:allow-stdin-write
└── src/
    └── commands/
        └── agent.rs        # spawn_sidecar, send_command, kill_sidecar, save_settings

src/
├── components/
│   ├── Outliner/
│   │   └── NodeEditor.tsx  # add SlashCommandExtension
│   └── Settings/
│       └── SettingsPage.tsx # API key management UI
├── extensions/
│   └── SlashCommand.tsx    # TipTap suggestion extension (mirrors HashtagNode pattern)
└── store/
    └── agentStore.ts       # Zustand: active generations, cancellation, streaming state
```

### Pattern 1: Pi RPC Sidecar Lifecycle

**What:** Node.js process running `pi --mode rpc` is spawned by Rust on app startup. Rust holds the child handle and an async receiver. Frontend sends commands via Tauri IPC; Rust serializes to JSONL and writes to sidecar stdin. Sidecar emits JSONL to stdout; Rust reads and re-emits to frontend via `app.emit()`.

**When to use:** Always — this is the only architecture.

**Rust spawn pattern (from tauri-plugin-shell docs):**
```rust
// Source: https://v2.tauri.app/develop/sidecar/
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

let sidecar_command = app.shell().sidecar("ai-sidecar").unwrap();
let (mut rx, mut child) = sidecar_command.spawn().expect("Failed to spawn sidecar");

// Forward stdout to frontend as Tauri events
tauri::async_runtime::spawn(async move {
    while let Some(event) = rx.recv().await {
        if let CommandEvent::Stdout(line_bytes) = event {
            let line = String::from_utf8_lossy(&line_bytes);
            // Parse JSONL and emit to frontend
            app_handle.emit("agent-event", line.as_ref()).unwrap();
        }
    }
});
```

**Frontend send-command pattern:**
```typescript
// Rust IPC command writes JSON line to sidecar stdin
await invoke('agent_command', {
  command: JSON.stringify({ type: 'prompt', text: '/ask quantum computing' })
})

// Listen for streaming events
const unlisten = await listen('agent-event', (event) => {
  const msg = JSON.parse(event.payload as string)
  if (msg.type === 'message_update') {
    // msg.assistantMessageEvent.delta — stream token to tree
  }
})
```

### Pattern 2: Slash Command TipTap Extension

**What:** `@tiptap/suggestion` with `char: '/'`, `startOfLine: false`, `allowSpaces: true`. On selection, the suggestion `command` handler captures the full matched text (skill name + args), stores it in node metadata, clears the typed text from the editor, and dispatches an agent command.

**The key difference from HashtagNode:** Slash commands fire an action rather than inserting a node; the trigger text is deleted from the editor content and stored only in metadata.

```typescript
// Source: existing HashtagNode.tsx pattern in project
Suggestion({
  editor: this.editor,
  char: '/',
  startOfLine: false,   // trigger anywhere in line (locked decision)
  allowSpaces: true,    // '/research quantum computing' — spaces in arg
  allowedPrefixes: null, // allow any prefix

  items: ({ query }) => {
    // query = 'research quantum' — filter by skill name prefix
    const skillName = query.split(' ')[0]
    return SKILLS.filter(s => s.name.startsWith(skillName))
  },

  command: ({ editor, range, props: skill }) => {
    // Capture the full typed text including args
    // range covers from '/' to cursor
    const fullText = editor.state.doc.textBetween(range.from, range.to)
    const args = fullText.slice(skill.name.length + 1).trim() // after '/skillname '

    // Delete the slash command text from editor content
    editor.chain().focus().deleteRange(range).run()

    // Store command in metadata and dispatch to agent
    onSlashCommand(nodeId, skill.id, args)
  }
})
```

### Pattern 3: Streaming Into the Tree

**What:** While the sidecar streams tokens, a ghost node (node_type='agent_response') is inserted as a child of the triggering node. Its content is updated in the Zustand store (updateNodeLocally) on each token — no IPC round-trip per token. Only on stream completion is the final content persisted to SQLite.

**Cancellation:** Escape key sends `{ type: 'abort' }` via stdin to the sidecar. Frontend cleans up ghost node or marks it as partial.

```
Token arrives via agent-event → agentStore.appendToken(nodeId, delta)
  → updateNodeLocally(ghostNodeId, { content: accumulated })
  → on turn_end: updateContent(ghostNodeId, finalContent) [persists to DB]
  → on abort: deleteNode(ghostNodeId) or mark partial
```

### Pattern 4: API Key Storage

**What:** The Node.js sidecar owns key storage. On startup, sidecar reads `~/.config/ai-chat/settings.json.enc` (or platform equivalent via `app.path.appData()`). File is AES-256-GCM encrypted. Encryption key is derived from a machine-specific value (machine ID or a randomly generated key stored in a separate file with restricted permissions). The sidecar exposes `get_settings` / `save_settings` RPC commands; frontend calls these via the Tauri Rust bridge.

**Simpler alternative:** Rust command reads/writes the encrypted file directly. Sidecar receives provider/model config as part of each `prompt` command's options. This avoids state in the sidecar and is the recommended approach.

### Anti-Patterns to Avoid

- **Streaming via Tauri IPC commands (invoke):** Commands are request-response only; cannot stream. Must use `app.emit()` events for streaming.
- **Persisting on every token:** Flushing each delta to SQLite creates thousands of writes per generation. Buffer in memory; persist on completion only.
- **Short-lived sidecar per command:** Do NOT spawn a new sidecar process per slash command. The sidecar must be long-lived and session-aware.
- **Unicode-aware line splitting on RPC output:** Pi RPC documentation explicitly warns against generic line readers that split on Unicode separators within JSON. Always split on `\n` byte only.
- **Allowing `allowedPrefixes: [' ']` (default) for slash commands:** Default allowedPrefixes requires a space before the trigger char. Set `allowedPrefixes: null` to trigger slash commands at any position.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Multi-provider LLM streaming | Custom HTTP SSE client per provider | pi-coding-agent (bundles pi-ai) | Handles streaming, retries, provider auth, model discovery across 15+ providers |
| Skill invocation & routing | Custom skill dispatcher | pi RPC `prompt` command + skill discovery | Pi skills follow standard; `/skill:name` routing built-in |
| Session/conversation management | Custom message history | pi SessionManager | Handles auto-compaction, token counting, branching |
| JSONL framing | Custom line protocol | pi RPC spec (LF-only) | Already specified; must respect `\n` only delimiter |
| Encrypted secrets file | Custom crypto | Node.js `crypto.createCipheriv('aes-256-gcm', ...)` | AES-256-GCM is a single well-understood primitive; no library needed |
| Suggestion popup keyboard nav | Custom keyboard handler | Existing SuggestionPopup pattern from HashtagNode.tsx | Already built and tested in project |

**Key insight:** Pi's RPC mode gives a complete agent runtime with streaming, skills, and multi-provider support via stdin/stdout. The Rust layer is purely a bridge — it should not attempt to parse or transform agent semantics.

---

## Common Pitfalls

### Pitfall 1: CRLF Line Endings Break Pi RPC

**What goes wrong:** On Windows or if any middleware converts `\n` to `\r\n`, pi RPC silently fails to parse commands.
**Why it happens:** Pi docs explicitly state "strict LF-delimited JSONL framing. Clients must split records on `\n` only."
**How to avoid:** When writing to sidecar stdin in Rust, always use `b"\n"` not `b"\r\n"`. On reading stdout, split on `\n` bytes, not newline strings.
**Warning signs:** Commands sent but no response from sidecar; `message_update` events never fire.

### Pitfall 2: Tauri Shell Plugin Not Installed

**What goes wrong:** The project currently has no `tauri-plugin-shell` in Cargo.toml or capabilities. Attempting to spawn a sidecar without the plugin causes a runtime panic.
**Why it happens:** Tauri v2 requires explicit plugin installation — `tauri::Builder::plugin(tauri_plugin_shell::init())` must be added to `lib.rs`.
**How to avoid:** Run `npm run tauri add shell` (or manual setup) before writing sidecar spawn code.
**Warning signs:** `app.shell()` method not found on `AppHandle`.

### Pitfall 3: Sidecar Binary Naming (Target Triple)

**What goes wrong:** The sidecar binary at `src-tauri/binaries/ai-sidecar` is not found at runtime.
**Why it happens:** Tauri requires architecture-specific suffix: `ai-sidecar-aarch64-apple-darwin` for macOS ARM, `ai-sidecar-x86_64-apple-darwin` for macOS Intel.
**How to avoid:** `rustc --print host-tuple` gives the correct suffix. Build script must rename the pkg output accordingly.
**Warning signs:** App starts but sidecar spawn fails with "binary not found."

### Pitfall 4: Slash '/' Triggers on Every Slash in URLs

**What goes wrong:** User types a URL like `https://example.com/path` and the suggestion popup fires after the `/`.
**Why it happens:** TipTap suggestion with `char: '/'` and `startOfLine: false` triggers on any `/` character.
**How to avoid:** Use the `allow` option in Suggestion config to check whether the character before `/` is `:` (indicating `://` URL context). Alternatively, check `allowedPrefixes` — setting it to `null` allows any prefix but the `allow` callback can filter.

```typescript
allow: ({ state, range }) => {
  const before = state.doc.textBetween(Math.max(0, range.from - 2), range.from)
  // Don't trigger after ':' (e.g., 'https:/')
  return !before.endsWith(':')
},
```

### Pitfall 5: Ghost Node Leaks on App Close During Generation

**What goes wrong:** User closes app while agent is streaming. On next launch, a dangling node_type='agent_response' with partial content exists in the tree.
**Why it happens:** The ghost node was written to SQLite before generation completed.
**How to avoid:** Add a `generation_state` column or check for nodes with empty/null content and node_type='agent_response' on startup. Optionally use a metadata flag `{ "partial": true }` that gets cleared on completion.

### Pitfall 6: pkg Binary macOS Notarization

**What goes wrong:** Tauri app fails macOS notarization when sidecar binary is a `pkg`-compiled Node.js binary.
**Why it happens:** Known GitHub issue (#11992) — macOS notarization rejects unsigned external binaries. The pkg binary must be separately code-signed.
**How to avoid:** Use `codesign --deep --force --sign "Developer ID Application: ..."` on the pkg binary before bundling. Set `hardenedRuntime: true` in Tauri's macOS bundle config.
**Warning signs:** Notarization succeeds when externalBin is removed, fails when added.

### Pitfall 7: Concurrent Edits Clobber agentStore State

**What goes wrong:** User triggers two slash commands simultaneously; token events from both interleave in agentStore.
**Why it happens:** agentStore must track active generation state per-node, not globally.
**How to avoid:** Key the `activeGenerations` map in agentStore by `nodeId`. Each generation has its own ghost node ID and token accumulator.

---

## Code Examples

Verified patterns from official sources:

### Pi RPC: Send a Prompt
```typescript
// Source: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
// Write to sidecar stdin (Rust side)
const command = {
  type: 'prompt',
  text: 'Explain quantum computing in simple terms',
  // id is optional — include for request correlation
  id: 'req-123'
}
// process.stdout.write(JSON.stringify(command) + "\n") — from sidecar perspective
// In Rust: child.write(format!("{}\n", serde_json::to_string(&command)?).as_bytes())
```

### Pi RPC: Handle Streaming Response
```typescript
// Source: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md
// Frontend listener for agent events
listen<string>('agent-event', (event) => {
  const msg = JSON.parse(event.payload)
  switch (msg.type) {
    case 'message_update':
      if (msg.assistantMessageEvent?.type === 'text_delta') {
        agentStore.appendToken(generationId, msg.assistantMessageEvent.delta)
      }
      break
    case 'turn_end':
      agentStore.finalizeGeneration(generationId)
      break
    case 'agent_end':
      agentStore.clearGeneration(generationId)
      break
  }
})
```

### Pi RPC: Abort Generation
```typescript
// Source: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
const abortCommand = { type: 'abort' }
await invoke('agent_command', { command: JSON.stringify(abortCommand) })
```

### TipTap Slash Command Extension (Based on Existing HashtagNode Pattern)
```typescript
// Source: existing /src/extensions/HashtagNode.tsx in this project
// Slash commands use identical Suggestion() API — char changes from '#' to '/'
Suggestion({
  editor: this.editor,
  char: '/',
  startOfLine: false,     // trigger mid-line (locked decision)
  allowSpaces: true,      // allow '/research quantum computing'
  allowedPrefixes: null,  // allow slash after any character

  allow: ({ state, range }) => {
    // Don't trigger after ':' to avoid matching 'https://...'
    const textBefore = state.doc.textBetween(Math.max(0, range.from - 2), range.from)
    return !textBefore.endsWith(':')
  },

  items: ({ query }) => {
    const skillPrefix = query.split(' ')[0].toLowerCase()
    return SKILLS.filter(s => s.name.startsWith(skillPrefix))
  },

  command: ({ editor, range, props: skill }) => {
    const fullText = editor.state.doc.textBetween(range.from, range.to)
    const userArg = fullText.slice(skill.name.length + 1).trim()
    editor.chain().focus().deleteRange(range).run()
    onSkillInvoked(skill.id, userArg)
  },

  render: () => { /* identical to HashtagNode SuggestionPopup render */ }
})
```

### Tauri Rust: Spawn Long-Running Sidecar
```rust
// Source: https://v2.tauri.app/develop/sidecar/
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tauri::Emitter;

pub async fn spawn_agent_sidecar(app: &tauri::AppHandle) {
    let sidecar = app.shell().sidecar("ai-sidecar").unwrap();
    let (mut rx, child) = sidecar.spawn().expect("Failed to spawn sidecar");

    // Store child handle in AppState for later stdin writes and kill
    // app.manage(SidecarState { child: Mutex::new(child) });

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    app_handle.emit("agent-event", line.as_ref()).ok();
                }
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
    });
}
```

### Tauri Capabilities: Shell Permissions
```json
// Source: https://v2.tauri.app/develop/sidecar/
// src-tauri/capabilities/default.json
{
  "permissions": [
    "core:default",
    {
      "identifier": "shell:allow-spawn",
      "allow": [{ "name": "binaries/ai-sidecar", "sidecar": true }]
    },
    "shell:allow-stdin-write",
    "shell:allow-kill"
  ]
}
```

### AES-256-GCM Key Storage (Node.js Sidecar Side)
```typescript
// Source: Node.js crypto documentation (built-in module)
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'

const ALGORITHM = 'aes-256-gcm'

export function encryptSettings(data: object, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Format: iv (12 bytes) + authTag (16 bytes) + ciphertext
  return Buffer.concat([iv, authTag, encrypted])
}

export function decryptSettings(encryptedBuf: Buffer, key: Buffer): object {
  const iv = encryptedBuf.subarray(0, 12)
  const authTag = encryptedBuf.subarray(12, 28)
  const ciphertext = encryptedBuf.subarray(28)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(decrypted.toString('utf8'))
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Custom HTTP SSE + per-provider SDK | Unified agent SDK (pi-coding-agent) | 2024-2025 | Eliminates per-provider integration; skills, streaming, session built-in |
| Tauri Stronghold for secrets | Encrypted file or OS keychain | Tauri v3 roadmap | Stronghold being deprecated; simple AES-GCM file is sufficient for v1 |
| Short-lived sidecar per request | Long-lived session-aware sidecar | Always best practice | Sidecar must be persistent for conversation context |
| WebSocket for sidecar IPC | stdin/stdout JSONL | Tauri 2.x era | Simpler, no port management, works without network stack |

**Deprecated/outdated:**
- Tauri Stronghold: Will be deprecated in v3; do not build primary secrets architecture on it
- Per-invocation sidecar spawning: No persistent session possible; breaks pi's session management

---

## Open Questions

1. **Pi RPC context injection**
   - What we know: Pi RPC `prompt` command sends user text; SDK `createAgentSession` accepts `messages` array for branching
   - What's unclear: How to inject ancestor chain as prior conversation turns via RPC mode specifically (vs SDK mode)
   - Recommendation: RPC has `get_messages` / `new_session` + `prompt` with `systemPrompt` option. Ancestor context can be embedded as a system message or as prior messages via `new_session` reset before each invocation. Validate in Wave 0 spike.

2. **pkg binary macOS signing in CI**
   - What we know: Known issue (#11992) — pkg binaries need separate codesign step before notarization
   - What's unclear: Whether this blocks development builds or only distribution
   - Recommendation: For dev builds, signing is not required. Skip notarization concern until Phase 6 (distribution). Note this in BLOCKERS.

3. **Skills directory location for embedded use**
   - What we know: Pi discovers skills from `.pi/skills/` (project) and `~/.agents/skills/` (global)
   - What's unclear: When pi runs as a sidecar with a packaged app, what `cwd` it uses and whether skills bundled inside the Tauri app bundle are discoverable
   - Recommendation: Pass `--agent-dir` flag to pi RPC pointing to app's resource directory. The `agentDir` option in `createAgentSession` controls this.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.1 |
| Config file | vite.config.ts (implicit) / `"test": "vitest run --reporter=verbose"` in package.json |
| Quick run command | `npm test` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INFR-01 | `encryptSettings` / `decryptSettings` round-trips correctly | unit | `npm test -- src-sidecar/keystore.test.ts` | ❌ Wave 0 |
| INFR-01 | Settings page renders provider inputs and submits via IPC | unit | `npm test -- src/components/Settings/SettingsPage.test.tsx` | ❌ Wave 0 |
| AGNT-01 | SlashCommand extension triggers on '/' and not on '://' | unit | `npm test -- src/extensions/SlashCommand.test.tsx` | ❌ Wave 0 |
| AGNT-01 | SlashCommand fires onSkillInvoked with correct skill ID and args | unit | `npm test -- src/extensions/SlashCommand.test.tsx` | ❌ Wave 0 |
| AGNT-02 | `buildContextMessages` maps ancestor chain to user/assistant turns correctly | unit | `npm test -- src/store/agentStore.test.ts` | ❌ Wave 0 |
| AGNT-02 | `agentStore.appendToken` updates ghost node content in Zustand | unit | `npm test -- src/store/agentStore.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-sidecar/keystore.test.ts` — covers INFR-01 encryption round-trip
- [ ] `src/components/Settings/SettingsPage.test.tsx` — covers INFR-01 UI
- [ ] `src/extensions/SlashCommand.test.tsx` — covers AGNT-01
- [ ] `src/store/agentStore.test.ts` — covers AGNT-02 context building and token streaming
- [ ] `src-sidecar/` directory with `package.json` and `tsconfig.json` — sidecar build setup

---

## Sources

### Primary (HIGH confidence)
- [pi-mono GitHub](https://github.com/badlogic/pi-mono) — monorepo structure, package architecture
- [pi-coding-agent docs/rpc.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) — RPC protocol, commands, events, JSONL framing
- [pi-coding-agent docs/sdk.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md) — SDK APIs, streaming events, session management
- [Tauri v2 Sidecar docs](https://v2.tauri.app/develop/sidecar/) — externalBin config, spawn, stdin/stdout, CommandEvent
- [Tauri v2 Node.js sidecar guide](https://v2.tauri.app/learn/sidecar-nodejs/) — pkg compilation, binary naming, target triples
- [Tauri v2 Calling Frontend](https://v2.tauri.app/develop/calling-frontend/) — `app.emit()`, `listen()`, Channel API
- [Tauri Shell Plugin](https://v2.tauri.app/plugin/shell/) — installation, permissions, spawn API
- [TipTap Suggestion utility](https://tiptap.dev/docs/editor/api/utilities/suggestion) — all config options, render hooks, command signature
- `src/extensions/HashtagNode.tsx` (this project) — exact pattern to replicate for slash commands

### Secondary (MEDIUM confidence)
- [@mariozechner/pi-coding-agent npm](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) — current version (0.58.3), four modes (interactive, print/JSON, RPC, SDK)
- [Tauri #11992 GitHub issue](https://github.com/tauri-apps/tauri/issues/11992) — macOS notarization known issue with sidecar binaries
- [Tauri Stronghold plugin](https://v2.tauri.app/plugin/stronghold/) — confirmed still available but being deprecated for v3

### Tertiary (LOW confidence)
- WebSearch results on pkg binary size and macOS signing workflow — cross-referenced with Tauri official docs

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — pi-coding-agent package verified on npm with active release history (latest v0.58.3, March 2026); RPC docs verified on GitHub; Tauri shell plugin verified in official docs
- Architecture: HIGH — all patterns derived from official Tauri sidecar docs and existing project code (HashtagNode.tsx)
- Pitfalls: HIGH — sidecar binary naming, CRLF framing, and notarization issues verified from official docs and GitHub issues
- API key storage: MEDIUM — AES-256-GCM approach is standard Node.js; Stronghold deprecation from Tauri docs confirmed

**Research date:** 2026-03-29
**Valid until:** 2026-04-29 (pi-coding-agent is under active development; check for breaking changes before implementation)
