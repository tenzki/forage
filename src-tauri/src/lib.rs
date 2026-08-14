// v1 ships with no custom Rust backend. All app logic lives in the TypeScript
// frontend. Rust only registers the official Tauri plugins the frontend calls:
//   - plugin-fs:    read/write the tree JSON file in the iCloud Drive folder
//   - plugin-store: persist the user's Codex credentials and settings
//   - plugin-http:   stream OpenAI requests without webview CORS restrictions
//   - plugin-opener: open the ChatGPT subscription login page

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}
