use serde::Serialize;
use specta::Type;
use std::fmt;

/// Typed error enum for IPC command handlers.
/// Derives `Serialize` and `Type` for tauri-specta export to TypeScript.
#[derive(Debug, Serialize, Type)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    /// Database-level error (sqlx, migration, connection)
    Db(String),
    /// Requested resource not found
    NotFound(String),
    /// Caller provided invalid input
    InvalidInput(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Db(msg) => write!(f, "Database error: {}", msg),
            AppError::NotFound(msg) => write!(f, "Not found: {}", msg),
            AppError::InvalidInput(msg) => write!(f, "Invalid input: {}", msg),
        }
    }
}

impl std::error::Error for AppError {}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        AppError::Db(err.to_string())
    }
}
