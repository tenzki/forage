// v1 ships with no custom Rust backend. All app logic lives in the TypeScript
// frontend. Rust only registers the official Tauri plugins the frontend calls:
//   - plugin-fs:    read/write the tree JSON file in the iCloud Drive folder
//   - plugin-store: persist the user's API key (encrypted at rest on disk)

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}
