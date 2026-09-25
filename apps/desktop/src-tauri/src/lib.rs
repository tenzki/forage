pub mod agent_sessions;
pub mod assets;
pub mod commands;
pub mod page_peek;
pub mod persistence;
pub mod server_stream;
pub mod server_transport;
pub mod shortcuts_key;
pub mod sync_commands;

// The privileged Rust boundary owns local durability and native integrations.
// It also registers the remaining official Tauri plugins used by the frontend:
//   - plugin-store: persist settings and non-secret credential metadata
//   - plugin-http:   stream OpenAI requests without webview CORS restrictions
//   - plugin-opener: open the ChatGPT subscription login page
//   - plugin-shell:  run the embedded Pi SDK in an isolated Node.js sidecar
//   - plugin-dialog: pick local extension directories with the native folder picker

/// Webviews that run the app's own pages. Any other webview, such as the link
/// peek's embedded page, shows untrusted remote content. Tauri checks the
/// capability ACL only for plugin commands and injects the IPC bridge into every
/// page, so app commands are gated here.
const TRUSTED_WEBVIEWS: &[&str] = &["main"];

pub fn run() {
    let builder = tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let event_store =
                persistence::EventStore::open(app_data.join("outline-events.sqlite3"))?;
            let asset_store = assets::AssetStore::new(app_data.join("assets"))?;
            // Nothing runs yet, so every session file without a run row is an orphan.
            let agent_sessions_dir = agent_sessions::directory(&app_data);
            if let Err(error) = agent_sessions::prune_orphaned(&event_store, &agent_sessions_dir) {
                eprintln!("failed to prune agent session files: {error}");
            }
            let http_client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(5))
                .timeout(std::time::Duration::from_secs(20))
                .user_agent("Forage/0.1.0")
                .build()?;
            app.manage(commands::NativeState {
                event_store,
                asset_store,
                agent_sessions_dir,
                http_client,
            });
            app.manage(server_stream::ServerStreamState::default());
            shortcuts_key::install(app.handle());
            Ok(())
        })
        .invoke_handler({
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            commands::event_store_append,
            commands::event_store_events_after,
            commands::event_store_events_before,
            commands::event_store_pending,
            commands::event_store_acknowledge,
            commands::event_store_supersede,
            commands::event_store_commit_rebase,
            commands::event_store_save_checkpoint,
            commands::event_store_latest_checkpoint,
            commands::event_store_sync_state,
            commands::event_store_record_pulled,
            commands::event_store_storage_mode,
            commands::event_store_set_storage_mode,
            commands::event_store_identity,
            commands::server_agent_configuration_mirror,
            commands::server_agent_set_configuration_mirror,
            commands::server_agent_remembered_runs,
            commands::server_agent_set_remembered_runs,
            commands::server_provisioning_state,
            commands::server_set_provisioning_state,
            commands::remembered_server_identity,
            commands::set_remembered_server_identity,
            commands::agent_run_admit,
            commands::agent_run_get,
            commands::agent_run_begin_attempt,
            commands::agent_run_append_activity,
            commands::agent_run_activity_after,
            commands::agent_run_recent,
            commands::agent_runs_clear,
            commands::agent_run_cancel,
            commands::agent_run_settle,
            commands::agent_run_place_result,
            commands::agent_run_retry,
            commands::agent_run_interrupt_unfinished,
            commands::local_credential_store,
            commands::local_credential_load,
            commands::local_credential_remove,
            commands::asset_ingest_data_url,
            commands::asset_read,
            page_peek::page_peek_prepare,
            page_peek::page_peek_load,
            page_peek::page_peek_show,
            page_peek::page_peek_set_bounds,
            page_peek::page_peek_set_visible,
            page_peek::page_peek_navigate,
            page_peek::page_peek_snapshot,
            page_peek::page_peek_close,
            sync_commands::server_enroll,
            sync_commands::server_seed_outline,
            commands::event_store_mark_seeded,
            sync_commands::server_test_connection,
            sync_commands::server_checkpoint,
            server_stream::server_stream_connect,
            server_stream::server_stream_disconnect,
            sync_commands::server_pull_events,
            sync_commands::server_push_events,
            sync_commands::server_upload_asset,
            sync_commands::server_download_asset,
            sync_commands::server_disconnect,
            sync_commands::server_connection_info,
            sync_commands::server_agent_configuration,
            sync_commands::server_agent_publish_configuration,
            sync_commands::server_agent_compute_profile,
            sync_commands::server_agent_publish_compute_profile,
            sync_commands::server_agent_readiness,
            sync_commands::server_outline_search,
            sync_commands::server_agent_automation,
            sync_commands::server_agent_publish_automation,
            sync_commands::server_agent_enroll_api_key,
            sync_commands::server_agent_import_credential,
            sync_commands::server_agent_start_device_authorization,
            sync_commands::server_agent_poll_device_authorization,
            sync_commands::server_agent_credential,
            sync_commands::server_agent_disconnect_credential,
            sync_commands::server_agent_invoke,
            sync_commands::server_agent_runs,
            sync_commands::server_agent_run,
            sync_commands::server_agent_activity,
            sync_commands::server_agent_cancel,
            sync_commands::server_agent_retry,
            sync_commands::server_agent_place,
            ];
            move |invoke| {
                if !TRUSTED_WEBVIEWS.contains(&invoke.message.webview_ref().label()) {
                    invoke.resolver.reject("app commands are not available to this webview");
                    return true;
                }
                handler(invoke)
            }
        })
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            use tauri::menu::{
                Menu, MenuItem, MenuItemKind, PredefinedMenuItem, WINDOW_SUBMENU_ID,
            };

            let menu = Menu::default(app)?;

            // Command+M is normally consumed by macOS before the webview sees it.
            // Keep Minimize available in the Window menu, but give its accelerator
            // to Forage's Move Bullet command.
            if let Some(MenuItemKind::Submenu(window_menu)) = menu.get(WINDOW_SUBMENU_ID) {
                window_menu.remove_at(0)?;
                let minimize = MenuItem::with_id(
                    app,
                    "forage-minimize-window",
                    "Minimize",
                    true,
                    None::<&str>,
                )?;
                window_menu.insert(&minimize, 0)?;
            }

            let move_bullet = MenuItem::with_id(
                app,
                "forage-move-current-bullet",
                "Move Bullet…",
                true,
                Some("CmdOrCtrl+M"),
            )?;
            for item in menu.items()? {
                if let MenuItemKind::Submenu(submenu) = item {
                    if submenu.text()? == "Edit" {
                        submenu.append(&PredefinedMenuItem::separator(app)?)?;
                        submenu.append(&move_bullet)?;
                        break;
                    }
                }
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            use tauri::{Emitter, Manager};

            if event.id() == "forage-move-current-bullet" {
                let _ = app.emit("forage-move-current-bullet", ());
            } else if event.id() == "forage-minimize-window" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.minimize();
                }
            }
        });

    builder
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}
