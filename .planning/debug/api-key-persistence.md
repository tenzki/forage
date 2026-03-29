---
status: awaiting_human_verify
trigger: "API key save STILL doesn't persist across app restart in a Tauri + Node.js sidecar app"
created: 2026-03-29T00:00:00Z
updated: 2026-03-29T00:00:00Z
---

## Current Focus

hypothesis: settingsStore.ts sendAndReceive() treats agent-event payload as an already-parsed object, but Rust emits it as a raw JSON string. This causes payload.id to always be undefined, triggering the 10-second timeout on every load/save. Settings fall back to defaults on every load.
test: Static analysis of all five files + cross-referencing agentStore.ts which correctly handles the string payload
expecting: Fix: parse payload string to object inside sendAndReceive()
next_action: Apply fix to settingsStore.ts sendAndReceive()

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
  settingsStore.ts sendAndReceive() types the agent-event payload as an object and accesses
  payload.id directly, but the Rust emitter emits raw JSON strings (consistent with agentStore.ts
  which correctly parses them). Because payload is actually a string, payload.id is always
  undefined, causing the event guard to always return early, causing every sendAndReceive call
  to hit the 10-second timeout. On loadSettings(), the timeout is caught and defaults are used.
  On saveProviderKey(), the sidecar writes to disk but sendAndReceive times out — this is a 10s
  hang on every save plus the data appears unsaved from the frontend's perspective.

fix: |
  In sendAndReceive() in settingsStore.ts:
  - Type the listen<> generic as string (matching how agentStore.ts does it)
  - Parse event.payload from string to object before accessing .id and .type
  - Match agentStore.ts pattern: `typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload`

verification: Fix applied. sendAndReceive() now parses the raw JSON string payload before accessing .id and .type fields. The listener guard will correctly match responses by ID. loadSettings() will resolve with the decrypted settings from disk instead of timing out and falling back to defaults.
files_changed:
  - src/store/settingsStore.ts
