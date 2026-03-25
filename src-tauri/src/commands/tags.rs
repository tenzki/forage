use serde::Serialize;
use sqlx::Row;
use tauri::State;

use crate::AppState;
use crate::errors::AppError;

/// A tag with its usage count across all nodes.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

/// Get all tags with their node counts, ordered by count descending.
#[tauri::command]
#[specta::specta]
pub async fn get_all_tags(
    state: State<'_, AppState>,
) -> Result<Vec<TagCount>, AppError> {
    let rows = sqlx::query(
        "SELECT tag, COUNT(*) as count FROM node_tags GROUP BY tag ORDER BY count DESC",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::Db(e.to_string()))?;

    let tags = rows
        .iter()
        .map(|row| {
            Ok(TagCount {
                tag: row.try_get("tag").map_err(|e| AppError::Db(e.to_string()))?,
                count: row.try_get("count").map_err(|e| AppError::Db(e.to_string()))?,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;

    Ok(tags)
}

/// Get tags matching a given prefix (for autocomplete suggestions).
/// Returns up to 10 matches ordered alphabetically.
#[tauri::command]
#[specta::specta]
pub async fn get_tags_matching(
    state: State<'_, AppState>,
    prefix: String,
) -> Result<Vec<String>, AppError> {
    let pattern = format!("{}%", prefix);

    let rows = sqlx::query(
        "SELECT DISTINCT tag FROM node_tags WHERE tag LIKE ?1 ORDER BY tag LIMIT 10",
    )
    .bind(&pattern)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::Db(e.to_string()))?;

    let tags = rows
        .iter()
        .map(|row| row.try_get("tag").map_err(|e| AppError::Db(e.to_string())))
        .collect::<Result<Vec<String>, AppError>>()?;

    Ok(tags)
}

/// Sync all tags for a node: replaces all existing tags with the provided list.
/// Uses a full-replace strategy: DELETE all + INSERT new.
#[tauri::command]
#[specta::specta]
pub async fn sync_node_tags(
    state: State<'_, AppState>,
    node_id: String,
    tags: Vec<String>,
) -> Result<(), AppError> {
    // Delete all existing tags for this node
    sqlx::query("DELETE FROM node_tags WHERE node_id = ?1")
        .bind(&node_id)
        .execute(&state.db)
        .await
        .map_err(|e| AppError::Db(e.to_string()))?;

    // Insert new tags
    for tag in &tags {
        sqlx::query("INSERT INTO node_tags (node_id, tag) VALUES (?1, ?2)")
            .bind(&node_id)
            .bind(tag)
            .execute(&state.db)
            .await
            .map_err(|e| AppError::Db(e.to_string()))?;
    }

    Ok(())
}
