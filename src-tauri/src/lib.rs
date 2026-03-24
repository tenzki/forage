use tauri::Manager;

pub mod db;
pub mod errors;

pub struct AppState {
    pub db: sqlx::SqlitePool,
}

pub fn run() {
    let builder = tauri_specta::Builder::<tauri::Wry>::new();

    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/lib/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .setup(move |app| {
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
