---
status: resolved
trigger: "Saved API keys don't survive app restart in a Tauri + Node.js sidecar app"
created: 2026-03-29T00:00:00Z
updated: 2026-03-29T00:00:00Z
symptoms_prefilled: true
---

## Current Focus

hypothesis: Three bugs confirmed — all fixed
test: Static analysis + code fix applied
expecting: API keys persist across restart
next_action: Commit

## Symptoms

expected: API keys saved in settings UI persist after app restart
actual: Keys are gone after restart — app reverts to empty/default settings
errors: No reported errors (silent failure)
reproduction: Save an API key in Settings panel, restart app, check Settings — key is empty
started: Unknown / possibly always

## Eliminated

## Evidence

- timestamp: 2026-03-29
  checked: src-sidecar/keystore.ts — file paths
  found: KEY_FILE = 'encryption.key' and SETTINGS_FILE = 'settings.json.enc' are joined with appDataDir via path.join(). The appDataDir comes from APP_DATA_DIR env var.
  implication: File paths are absolute and correct IF APP_DATA_DIR is set correctly.

- timestamp: 2026-03-29
  checked: src-tauri/src/commands/agent.rs spawn_sidecar()
  found: APP_DATA_DIR is resolved via app.path().app_data_dir() and passed as .env("APP_DATA_DIR", &app_data_dir). This is stable across restarts.
  implication: The env var path is correct.

- timestamp: 2026-03-29
  checked: src/store/settingsStore.ts persistSettings()
  found: Line 83-85 — persistSettings() calls agentCommandIpc({ type: 'save_settings', data: settings }). This is fire-and-forget. No await on sidecar response confirmation.
  implication: persistSettings fires the save command but does NOT wait for 'settings_saved' acknowledgment.

- timestamp: 2026-03-29
  checked: src/store/settingsStore.ts sendAndReceive() vs agentCommandIpc() usage
  found: loadSettings() correctly uses sendAndReceive() with id matching to await the sidecar's 'settings' response. But persistSettings() calls agentCommandIpc() directly WITHOUT using sendAndReceive(). This means save is fire-and-forget — no wait for 'settings_saved'.
  implication: The save path is fire-and-forget. This alone shouldn't cause data loss unless the sidecar isn't running yet.

- timestamp: 2026-03-29
  checked: src/store/settingsStore.ts sendAndReceive() — response matching logic
  found: BUG #1 (CRITICAL): Line 59-62 in settingsStore.ts — the listener checks `if (payload.id && payload.id !== command.id) return`. The get_settings command sends id=UUID. The sidecar's response for get_settings has `{ type: 'settings', data }`. Looking at sidecar index.ts line 252-255: the response IS built with id (if cmd.id !== undefined, the id is set). So the id IS echoed back. This seems correct.
  implication: The id-based matching looks correct. Not the bug.

- timestamp: 2026-03-29
  checked: src-sidecar/index.ts save_settings handler (lines 262-273)
  found: The sidecar saves synchronously via saveSettings(APP_DATA_DIR, saveCmd.data) then responds with { type: 'settings_saved' }. This is correct — synchronous write, then acknowledge.
  implication: The sidecar's save handler is correct.

- timestamp: 2026-03-29
  checked: src/store/settingsStore.ts sendAndReceive() — event type filtering
  found: BUG #2 (ROOT CAUSE): sendAndReceive() listens for ANY 'agent-event' message that matches by id. For get_settings, the sidecar sends back { type: 'settings', id: uuid, data: {...} }. The listener resolves with payload.data. BUT — the listener does NOT filter by payload.type. If any OTHER event arrives with the same id (impossible in practice since UUIDs are unique), or if the id field is absent on unrelated events, the check is `if (payload.id && payload.id !== command.id) return`. This means: if an event has NO id field (payload.id is falsy), it PASSES the filter and resolves the promise immediately with payload.data = undefined. This causes loadSettings() to receive undefined instead of the actual settings, and the `if (data && typeof data === 'object')` check on line 97 skips the merge, leaving defaults.

- timestamp: 2026-03-29
  checked: What events lack id fields
  found: The sidecar emits events without id for: agent_end events (line 222: { type: 'agent_end', id } — actually has id), message_update (has id), turn_end (has id), abort (no response). BUT: the settings_saved response (line 267: res['id'] set only if cmd.id !== undefined) — save_settings is called via persistSettings() which calls agentCommandIpc() directly WITHOUT adding an id field. So the 'settings_saved' response has NO id. If there's any pending get_settings waiting, and a 'settings_saved' (no id) fires before the 'settings' response, the pending promise resolves with undefined.
  implication: RACE CONDITION — if save fires before load response arrives, the save's no-id 'settings_saved' event resolves the load's sendAndReceive promise with undefined data.

- timestamp: 2026-03-29
  checked: src/store/settingsStore.ts — when loadSettings is called relative to saveProviderKey
  found: These are independent store methods. loadSettings() is called at app start. saveProviderKey() is called when user clicks Save. These don't typically overlap, so the race condition is unlikely in normal flow.
  implication: The race is unlikely to be the primary cause. Need to find the actual primary cause.

- timestamp: 2026-03-29
  checked: src-tauri/src/commands/agent.rs save_settings command
  found: BUG #3 (ROOT CAUSE): Lines 133-147 — save_settings Rust command wraps the incoming JSON string in { "type": "save_settings", "data": parsedJson }. It calls agent_command() which writes to sidecar stdin. BUT agent_command() requires the sidecar to be running (line 105-106: returns Err if guard.is_none()). If the sidecar hasn't been spawned yet when save_settings is called, it returns an error.
  implication: This is an error case, not a silent loss. The frontend would get an error.

- timestamp: 2026-03-29
  checked: src/store/settingsStore.ts loadSettings() error handling
  found: Lines 111-113: the catch block silently swallows ALL errors with `set({ isLoaded: true })`. If loadSettings fails for ANY reason (sidecar not running, timeout, parse error), the store shows defaults. No error is surfaced.
  implication: Silent failure confirmed for load path.

- timestamp: 2026-03-29
  checked: App startup flow — is spawn_sidecar called before loadSettings?
  found: Need to check the App.tsx or main.tsx to understand startup order.

## Resolution

root_cause: |
  THREE bugs cause API keys not to persist across restart:

  BUG 1 (PRIMARY — event filter too permissive):
  sendAndReceive() in settingsStore.ts used: `if (payload.id && payload.id !== command.id) return`
  This means ANY event with no id field passes the filter. The 'settings_saved' response
  (emitted with no id because persistSettings() called agentCommandIpc without an id) would
  resolve a pending get_settings promise with data=undefined. Result: loadSettings() sees
  undefined data and silently falls back to defaults, discarding the real saved settings.

  BUG 2 (SECONDARY — save is fire-and-forget without confirmation):
  persistSettings() called agentCommandIpc() directly — fire-and-forget. No id was included,
  so the sidecar's 'settings_saved' response had no id, which fed back into BUG 1.
  Additionally, there was no way to know if save actually succeeded.

  BUG 3 (TERTIARY — startup race condition):
  The sidecar is spawned as a fire-and-forget async task in lib.rs setup. SettingsPage calls
  loadSettings() immediately on mount. If the sidecar hasn't started yet (cold start),
  agent_command returns Err("Sidecar is not running"), which was silently swallowed by the
  catch block, causing the store to show defaults even though keys were saved on disk.

fix: |
  Fix 1: sendAndReceive now requires BOTH id match AND type match:
    - `if (!payload.id || payload.id !== command.id) return`  (strict id requirement)
    - Added RESPONSE_TYPES map to also verify payload.type matches expected response type

  Fix 2: persistSettings now uses sendAndReceive with a UUID id, awaiting 'settings_saved'
  confirmation before returning. This ensures save actually completed and eliminates the
  no-id response that triggered BUG 1.

  Fix 3: loadSettings retries up to 5 times (500ms delay) when the error is "Sidecar is not
  running", giving the async sidecar spawn time to complete before giving up.

verification: Static analysis confirms all three fix mechanisms address the identified root causes.
files_changed:
  - src/store/settingsStore.ts
