use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tokio::sync::Mutex;

/// Holds the running sidecar child process (if any).
/// Uses tokio Mutex because all command handlers are async.
pub struct SidecarState {
    pub child: Mutex<Option<CommandChild>>,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

/// Spawn the Node.js AI sidecar process.
/// Sets APP_DATA_DIR so the sidecar can locate its encrypted settings file.
/// Spawns an async reader task that forwards stdout lines to the frontend
/// via the "agent-event" Tauri event.
/// Called once on app startup — subsequent calls are no-ops if sidecar is running.
#[tauri::command]
pub async fn spawn_sidecar(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
) -> Result<(), String> {
    let mut guard = state.child.lock().await;

    // Already running — do not spawn again
    if guard.is_some() {
        return Ok(());
    }

    // Resolve APP_DATA_DIR for the sidecar process
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .to_string_lossy()
        .to_string();

    let sidecar_command = app
        .shell()
        .sidecar("ai-sidecar")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .env("APP_DATA_DIR", &app_data_dir);

    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

    *guard = Some(child);
    drop(guard);

    // Spawn async reader that forwards stdout JSONL lines to the frontend
    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    // Each line is a complete JSONL message
                    if let Ok(line) = String::from_utf8(bytes) {
                        let line = line.trim_end_matches('\n').to_string();
                        if !line.is_empty() {
                            app_handle.emit("agent-event", &line).ok();
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    if let Ok(msg) = String::from_utf8(bytes) {
                        eprintln!("[sidecar stderr] {}", msg.trim());
                    }
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[sidecar] Terminated with status: {:?}", status);
                    // Clear the stored child so spawn_sidecar can restart it
                    if let Some(sidecar_state) = app_handle.try_state::<SidecarState>() {
                        let mut guard = sidecar_state.child.lock().await;
                        *guard = None;
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Write a JSONL command to the sidecar's stdin.
/// The `command` parameter should be a JSON string (without trailing newline).
/// Returns an error if the sidecar is not running.
#[tauri::command]
pub async fn agent_command(
    state: tauri::State<'_, SidecarState>,
    command: String,
) -> Result<(), String> {
    let mut guard = state.child.lock().await;

    match guard.as_mut() {
        None => Err("Sidecar is not running".to_string()),
        Some(child) => {
            let line = format!("{}\n", command);
            child
                .write(line.as_bytes())
                .map_err(|e| format!("Failed to write to sidecar stdin: {e}"))
        }
    }
}

/// Kill the running sidecar process.
#[tauri::command]
pub async fn kill_sidecar(state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    let mut guard = state.child.lock().await;

    match guard.take() {
        None => Ok(()), // nothing to kill
        Some(child) => child
            .kill()
            .map_err(|e| format!("Failed to kill sidecar: {e}")),
    }
}

/// Fire-and-forget: send a save_settings command to the sidecar.
/// The sidecar will encrypt and persist the settings, then respond on the
/// "agent-event" channel with { type: 'settings_saved' }.
#[tauri::command]
pub async fn save_settings(
    state: tauri::State<'_, SidecarState>,
    settings: String,
) -> Result<(), String> {
    // settings must be a valid JSON string; wrap it in the save_settings envelope
    let _data: serde_json::Value = serde_json::from_str(&settings)
        .map_err(|e| format!("settings must be valid JSON: {e}"))?;

    let cmd = serde_json::json!({
        "type": "save_settings",
        "data": serde_json::from_str::<serde_json::Value>(&settings).unwrap()
    });

    agent_command(state, cmd.to_string()).await
}

/// Fire-and-forget: request settings from the sidecar.
/// The actual settings data arrives asynchronously via the "agent-event" Tauri event
/// with payload { type: 'settings', data: { ... } }.
/// The frontend must listen for that event to receive the response.
#[tauri::command]
pub async fn get_settings(state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    let cmd = serde_json::json!({ "type": "get_settings" });
    agent_command(state, cmd.to_string()).await
}
