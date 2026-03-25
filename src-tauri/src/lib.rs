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
    // Set up tauri-specta builder registering all five IPC commands.
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
        .setup(move |app| {
            // tauri::Builder::setup() is synchronous, but init_db is async.
            // bridge via block_on — this runs before any command handler.
            tauri::async_runtime::block_on(async move {
                let pool = db::setup::init_db(app)
                    .await
                    .expect("Failed to initialize database");
                app.manage(AppState { db: pool });
            });
            Ok(())
        })
        .invoke_handler(builder.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}
