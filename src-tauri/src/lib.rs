use tauri::Manager;

pub mod commands;
pub mod db;
pub mod errors;

/// Application state managed by Tauri.
/// `SqlitePool` is `Send + Sync + Clone` — no Mutex wrapping needed.
pub struct AppState {
    pub db: sqlx::SqlitePool,
}

pub fn run() {
    // Set up tauri-specta builder for commands that use specta-derived types.
    // Agent commands use tauri::State and AppHandle which are not specta-derived,
    // so they are registered separately via tauri::generate_handler! below.
    let builder = tauri_specta::Builder::<tauri::Wry>::new().commands(tauri_specta::collect_commands![
        commands::nodes::create_node,
        commands::nodes::get_node,
        commands::nodes::get_children,
        commands::nodes::update_node,
        commands::nodes::move_node,
        commands::nodes::delete_node,
        commands::nodes::change_node_type,
        commands::search::search_nodes,
        commands::search::get_ancestors,
        commands::undo::record_undo_step,
        commands::undo::undo_step,
        commands::undo::redo_step,
        commands::tags::get_all_tags,
        commands::tags::get_tags_matching,
        commands::tags::sync_node_tags,
    ]);

    // Export TypeScript bindings in debug builds only.
    // Creates src/lib/bindings.ts for the frontend to consume.
    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/lib/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            // Capture app handle before moving app into the async block
            let app_handle_for_sidecar = app.handle().clone();

            // tauri::Builder::setup() is synchronous, but init_db is async.
            // bridge via block_on — this runs before any command handler.
            tauri::async_runtime::block_on(async move {
                let pool = db::setup::init_db(app)
                    .await
                    .expect("Failed to initialize database");
                app.manage(AppState { db: pool });
                app.manage(commands::agent::SidecarState::default());
            });

            // Spawn the sidecar on startup (fire-and-forget — does not block app start)
            let app_handle = app_handle_for_sidecar;
            tauri::async_runtime::spawn(async move {
                let sidecar_state = app_handle.state::<commands::agent::SidecarState>();
                if let Err(e) = commands::agent::spawn_sidecar(app_handle.clone(), sidecar_state).await {
                    eprintln!("[app] Failed to spawn sidecar on startup: {e}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::nodes::create_node,
            commands::nodes::get_node,
            commands::nodes::get_children,
            commands::nodes::update_node,
            commands::nodes::move_node,
            commands::nodes::delete_node,
            commands::nodes::change_node_type,
            commands::search::search_nodes,
            commands::search::get_ancestors,
            commands::undo::record_undo_step,
            commands::undo::undo_step,
            commands::undo::redo_step,
            commands::tags::get_all_tags,
            commands::tags::get_tags_matching,
            commands::tags::sync_node_tags,
            commands::agent::spawn_sidecar,
            commands::agent::agent_command,
            commands::agent::kill_sidecar,
            commands::agent::save_settings,
            commands::agent::get_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}
