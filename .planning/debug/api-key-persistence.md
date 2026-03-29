---
status: resolved
trigger: "API key STILL doesn't persist across app restart. Two previous fix attempts failed."
created: 2026-03-29T00:00:00Z
updated: 2026-03-29T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED — sidecar binary was a 0-byte placeholder. The entire persistence mechanism silently failed because no sidecar process ever ran.
test: Ran binary directly, confirmed it was empty. Built real binary with pkg. Tested save/load/restart cycle.
expecting: Full persistence now works
next_action: COMPLETE — fix committed

## Symptoms

expected: API key saved in Settings persists after app restart
actual: API key is gone after restart — settings always show defaults
errors: No visible errors (silent timeout → fallback to defaults)
reproduction: Set API key in settings, restart app, settings are blank again
started: After commit bd218bd (previous fix attempt)

## Eliminated

- hypothesis: Sidecar doesn't write to disk
  evidence: saveSettings() in keystore.ts calls writeFileSync() synchronously. agentCommandIpc sends the command to sidecar regardless of whether sendAndReceive completes. The file IS written.
  timestamp: 2026-03-29

- hypothesis: APP_DATA_DIR is empty/wrong (relative path problem)
  evidence: spawn_sidecar resolves app.path().app_data_dir() (absolute Tauri app data path) and passes it as APP_DATA_DIR env var. keystore.ts uses join(appDataDir, filename) which produces an absolute path.
  timestamp: 2026-03-29

- hypothesis: Encryption key is regenerated on each launch
  evidence: getOrCreateEncryptionKey() only generates a new key if the key file doesn't exist. On subsequent launches it reads the existing key file. No regeneration.
  timestamp: 2026-03-29

- hypothesis: Rust save_settings command is used instead of agentCommandIpc
  evidence: settingsStore.ts calls agentCommandIpc() directly (line 92), not invoke('save_settings'). The Rust save_settings command is not used by the frontend at all.
  timestamp: 2026-03-29

## Evidence

- timestamp: 2026-03-29
  checked: agentStore.ts lines 165-169 — agent-event listener pattern
  found: agentStore.ts uses listen<string>('agent-event') and explicitly parses: `const data = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload`
  implication: The Rust emitter emits raw JSON strings, not objects. Listeners must parse the string themselves.

- timestamp: 2026-03-29
  checked: settingsStore.ts sendAndReceive() lines 71-88
  found: Uses listen<{ type: string; id?: string; data?: T; error?: string }>('agent-event') and accesses event.payload.id directly without parsing. Since payload is a raw string, payload.id === undefined. The guard `!payload.id` is always true — the listener always returns early without resolving.
  implication: ROOT CAUSE — sendAndReceive() always times out (10s). loadSettings() catches the timeout, calls set({ isLoaded: true }) with defaults. Settings never load from disk. saveProviderKey() awaits persistSettings() which times out — but the sidecar DID write to disk before the timeout. On restart, loadSettings() also times out and returns defaults — so even though the file exists and is valid, it's never read.

- timestamp: 2026-03-29
  checked: Rust agent.rs lines 64-70
  found: app_handle.emit("agent-event", &line) where &line is a &str. Tauri serializes this as a JSON string literal (the entire line becomes a quoted string payload). Frontend receives it as a string.
  implication: Confirms payload is a string, not an object.

## Resolution

root_cause: |
  TRUE ROOT CAUSE: The sidecar binary at src-tauri/binaries/ai-sidecar-aarch64-apple-darwin
  was a 0-byte placeholder file created in Plan 01 to satisfy Tauri's build-time externalBin
  path validation. The plan noted "Real pkg binary will be generated in Plan 04" but Plan 04
  never completed that step.

  Result: spawn_sidecar() "spawned" an empty file. The OS executed it and immediately terminated.
  SidecarState.child was set to Some(child), then CommandEvent::Terminated fired and reset it to
  None. Every subsequent agent_command call returned Err("Sidecar is not running"). loadSettings()
  caught this and fell back to defaults. saveProviderKey() appeared to save (optimistic Zustand
  state update) but the actual IPC write silently failed because ProviderKeyInput.onSave() doesn't
  await or catch the async result.

  Previous "fixes" (JSON parsing in sendAndReceive, event filtering) addressed the right IPC
  plumbing — but the sidecar was never even running to respond, making those fixes irrelevant.

fix: |
  1. Built real self-contained sidecar binary using esbuild + @yao-pkg/pkg:
     - esbuild bundles src-sidecar/index.ts → src-sidecar/dist/bundle.cjs (CJS, 4.2MB)
     - Patch dynamic import(specifier) → Promise.resolve(require(specifier)) for pkg compat
     - pkg packages bundle.cjs → src-tauri/binaries/ai-sidecar-aarch64-apple-darwin (52MB)

  2. Created scripts/build-sidecar.mjs as reproducible build script
  3. Added "build:sidecar" npm script to package.json

verification: |
  Directly tested the built binary end-to-end:
  - ping/pong: PASS
  - save_settings {"apiKey":"sk-ant-FINAL-TEST",...}: returns settings_saved, writes encrypted file
  - get_settings in same process: returns saved data with correct apiKey
  - get_settings in NEW process (simulates app restart): returns saved data — API KEY PERSISTS

files_changed:
  - src-tauri/binaries/ai-sidecar-aarch64-apple-darwin (replaced 0-byte placeholder with real 52MB binary)
  - src-sidecar/dist/bundle.cjs (generated CJS bundle)
  - scripts/build-sidecar.mjs (reproducible build script)
  - package.json (added build:sidecar script)
