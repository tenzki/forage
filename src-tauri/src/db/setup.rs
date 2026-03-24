use sqlx::SqlitePool;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use std::str::FromStr;
use tauri::Manager;

/// Initialize the SQLite database pool with WAL mode and run embedded migrations.
///
/// Resolves the database path via Tauri v2's `app.path().app_data_dir()` —
/// this resolves to `~/Library/Application Support/com.ai-chat.app/` on macOS.
///
/// Connection options applied:
/// - WAL journal mode (persists after first set)
/// - Synchronous = Normal (2-3x faster writes in WAL mode, still crash-safe)
/// - foreign_keys = ON (referential integrity for parent_id)
/// - busy_timeout = 5s (prevents immediate lock errors under concurrent access)
/// - optimize_on_close = true (runs PRAGMA optimize on connection close)
pub async fn init_db(app: &tauri::App) -> Result<SqlitePool, Box<dyn std::error::Error>> {
    let mut data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    data_dir.push("ai-chat.db");

    let url = format!("sqlite:{}", data_dir.display());

    let opts = SqliteConnectOptions::from_str(&url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5))
        .optimize_on_close(true, None);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;

    // Run embedded SQL migrations from src-tauri/migrations/
    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}
