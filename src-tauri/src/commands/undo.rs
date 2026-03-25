use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::Row;
use tauri::State;

use crate::AppState;
use crate::errors::AppError;

/// Result returned by undo_step and redo_step to tell the frontend
/// which nodes were affected and need to be reloaded.
#[derive(Debug, Serialize, Deserialize, Type)]
pub struct UndoResult {
    pub node_ids: Vec<String>,
    pub operation: String,
}

/// Record a new undo step.
///
/// 1. Clears all undo_history entries AFTER the current pointer (redo stack).
/// 2. Inserts the new step with before/after snapshots.
/// 3. Advances undo_pointer to the new entry's id.
#[tauri::command]
#[specta::specta]
pub async fn record_undo_step(
    state: State<'_, AppState>,
    operation: String,
    node_id: String,
    before_json: String,
    after_json: String,
    group_key: Option<String>,
) -> Result<(), AppError> {
    // Read current pointer position.
    let position: i64 = sqlx::query("SELECT position FROM undo_pointer WHERE id = 1")
        .fetch_one(&state.db)
        .await
        .map(|r| r.get::<i64, _>("position"))
        .unwrap_or(0);

    // Clear any redo entries (entries with id > current position).
    sqlx::query("DELETE FROM undo_history WHERE id > ?1")
        .bind(position)
        .execute(&state.db)
        .await?;

    // Insert the new undo step and get its id in a single query.
    // Using RETURNING avoids a separate last_insert_rowid() call which can
    // return wrong results when the connection pool assigns different connections.
    let new_id: i64 = sqlx::query_scalar(
        "INSERT INTO undo_history (operation, node_id, before_json, after_json, group_key)
         VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
    )
    .bind(&operation)
    .bind(&node_id)
    .bind(&before_json)
    .bind(&after_json)
    .bind(&group_key)
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::Db(e.to_string()))?;

    sqlx::query("UPDATE undo_pointer SET position = ?1 WHERE id = 1")
        .bind(new_id)
        .execute(&state.db)
        .await?;

    Ok(())
}

/// Apply a node snapshot (JSON string) back to the nodes table.
///
/// Parses the JSON to extract all node fields and uses INSERT OR REPLACE
/// to restore the row exactly as it was.
async fn apply_node_snapshot(
    pool: &sqlx::SqlitePool,
    node_json: &str,
) -> Result<String, AppError> {
    let node: serde_json::Value = serde_json::from_str(node_json)
        .map_err(|e| AppError::InvalidInput(format!("Invalid snapshot JSON: {}", e)))?;

    let id = node["id"]
        .as_str()
        .ok_or_else(|| AppError::InvalidInput("Snapshot missing 'id' field".to_string()))?
        .to_string();

    let parent_id = node["parent_id"].as_str().map(|s| s.to_string());
    let position = node["position"]
        .as_str()
        .ok_or_else(|| AppError::InvalidInput("Snapshot missing 'position'".to_string()))?
        .to_string();
    let content = serde_json::to_string(&node["content"])
        .map_err(|e| AppError::InvalidInput(e.to_string()))?;
    let node_type = node["node_type"]
        .as_str()
        .ok_or_else(|| AppError::InvalidInput("Snapshot missing 'node_type'".to_string()))?
        .to_string();
    let collapsed: i64 = if node["collapsed"].as_bool().unwrap_or(false) {
        1
    } else {
        0
    };
    let skill_id = node["skill_id"].as_str().map(|s| s.to_string());
    let metadata = if node["metadata"].is_null() {
        None
    } else {
        Some(
            serde_json::to_string(&node["metadata"])
                .map_err(|e| AppError::InvalidInput(e.to_string()))?,
        )
    };
    let content_text = node["content_text"].as_str().unwrap_or("").to_string();
    let created_at = node["created_at"]
        .as_str()
        .unwrap_or("2026-01-01T00:00:00Z")
        .to_string();
    let updated_at = node["updated_at"]
        .as_str()
        .unwrap_or("2026-01-01T00:00:00Z")
        .to_string();

    sqlx::query(
        "INSERT OR REPLACE INTO nodes
             (id, parent_id, position, content, node_type, collapsed, skill_id, metadata, content_text, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )
    .bind(&id)
    .bind(&parent_id)
    .bind(&position)
    .bind(&content)
    .bind(&node_type)
    .bind(collapsed)
    .bind(&skill_id)
    .bind(&metadata)
    .bind(&content_text)
    .bind(&created_at)
    .bind(&updated_at)
    .execute(pool)
    .await?;

    Ok(id)
}

/// Undo the last recorded step (or group).
///
/// - Reads current pointer.
/// - Finds the entry at that position.
/// - If it has a group_key, finds all entries with same group_key.
/// - Applies before_json for each entry (restoring old state).
/// - For 'create' operation: before_json is '{}' — DELETE the node.
/// - For 'delete' operation: before_json has full node data — INSERT OR REPLACE.
/// - For other operations: apply the before_json snapshot via INSERT OR REPLACE.
/// - Moves pointer to min_id - 1 (or 0).
#[tauri::command]
#[specta::specta]
pub async fn undo_step(state: State<'_, AppState>) -> Result<Option<UndoResult>, AppError> {
    let position: i64 = sqlx::query("SELECT position FROM undo_pointer WHERE id = 1")
        .fetch_one(&state.db)
        .await
        .map(|r| r.get::<i64, _>("position"))
        .unwrap_or(0);

    if position == 0 {
        return Ok(None); // Nothing to undo
    }

    // Fetch the entry at or before current position.
    // The exact entry may have been cascade-deleted (ON DELETE CASCADE from nodes),
    // so we scan backwards to find the nearest surviving entry.
    let row = sqlx::query(
        "SELECT id, operation, node_id, before_json, after_json, group_key FROM undo_history WHERE id <= ?1 ORDER BY id DESC LIMIT 1",
    )
    .bind(position)
    .fetch_optional(&state.db)
    .await?;

    let row = match row {
        Some(r) => r,
        None => {
            // No entries at or before position — reset pointer to 0
            sqlx::query("UPDATE undo_pointer SET position = 0 WHERE id = 1")
                .execute(&state.db)
                .await?;
            return Ok(None);
        }
    };

    let operation: String = row.get("operation");
    let group_key: Option<String> = row.get("group_key");

    // Collect all entries to undo — read FULL row data (including after_json for cascade-safety).
    // NOTE: undo_history has ON DELETE CASCADE from nodes. When we undo a 'create' by
    // deleting the node, the undo_history entry is also cascade-deleted. We must save
    // the full row data BEFORE deletion so redo can re-insert the entry.
    #[derive(Clone)]
    struct UndoEntry {
        id: i64,
        operation: String,
        node_id: String,
        before_json: String,
        after_json: String,
        group_key: Option<String>,
    }

    let entries: Vec<UndoEntry> = if let Some(ref gk) = group_key {
        // Group undo: fetch all entries with same group_key.
        let rows = sqlx::query(
            "SELECT id, operation, node_id, before_json, after_json, group_key FROM undo_history WHERE group_key = ?1 ORDER BY id ASC",
        )
        .bind(gk)
        .fetch_all(&state.db)
        .await?;

        rows.iter()
            .map(|r| UndoEntry {
                id: r.get("id"),
                operation: r.get("operation"),
                node_id: r.get("node_id"),
                before_json: r.get("before_json"),
                after_json: r.get("after_json"),
                group_key: r.get("group_key"),
            })
            .collect()
    } else {
        vec![UndoEntry {
            id: row.get("id"),
            operation: operation.clone(),
            node_id: row.get("node_id"),
            before_json: row.get("before_json"),
            after_json: row.get("after_json"),
            group_key: row.get("group_key"),
        }]
    };

    if entries.is_empty() {
        return Ok(None);
    }

    let min_id = entries.iter().map(|e| e.id).min().unwrap_or(0);
    let mut node_ids: Vec<String> = Vec::new();

    // Apply each before_json (restore old state).
    for entry in &entries {
        match entry.operation.as_str() {
            "create" => {
                // Before create: node didn't exist — delete it.
                // No FK cascade since migration 0003 removed the FK constraint.
                sqlx::query("DELETE FROM nodes WHERE id = ?1")
                    .bind(&entry.node_id)
                    .execute(&state.db)
                    .await?;

                node_ids.push(entry.node_id.clone());
            }
            _ => {
                // For delete, move, indent, outdent, text_edit: restore before snapshot.
                if entry.before_json != "{}" && !entry.before_json.is_empty() {
                    let restored_id = apply_node_snapshot(&state.db, &entry.before_json).await?;
                    node_ids.push(restored_id);
                } else {
                    node_ids.push(entry.node_id.clone());
                }
            }
        }
    }

    // Move pointer to before the group.
    let new_position = min_id - 1;
    sqlx::query("UPDATE undo_pointer SET position = ?1 WHERE id = 1")
        .bind(new_position)
        .execute(&state.db)
        .await?;

    Ok(Some(UndoResult {
        node_ids,
        operation,
    }))
}

/// Redo the next recorded step (or group).
///
/// - Reads current pointer.
/// - Finds the first entry AFTER the current position (next in redo stack).
/// - If it has a group_key, finds all entries with same group_key.
/// - Applies after_json for each entry (re-applying the operation).
/// - Moves pointer to max_id of the redone group.
#[tauri::command]
#[specta::specta]
pub async fn redo_step(state: State<'_, AppState>) -> Result<Option<UndoResult>, AppError> {
    let position: i64 = sqlx::query("SELECT position FROM undo_pointer WHERE id = 1")
        .fetch_one(&state.db)
        .await
        .map(|r| r.get::<i64, _>("position"))
        .unwrap_or(0);

    // Find the next entry after current position.
    let next_row = sqlx::query(
        "SELECT id, operation, node_id, after_json, group_key FROM undo_history WHERE id > ?1 ORDER BY id ASC LIMIT 1",
    )
    .bind(position)
    .fetch_optional(&state.db)
    .await?;

    let next_row = match next_row {
        Some(r) => r,
        None => return Ok(None), // Nothing to redo
    };

    let operation: String = next_row.get("operation");
    let group_key: Option<String> = next_row.get("group_key");

    // Collect all entries to redo — read FULL row data (including before_json for cascade-safety).
    #[derive(Clone)]
    struct RedoEntry {
        id: i64,
        operation: String,
        node_id: String,
        before_json: String,
        after_json: String,
        group_key: Option<String>,
    }

    let entries: Vec<RedoEntry> = if let Some(ref gk) = group_key {
        let rows = sqlx::query(
            "SELECT id, operation, node_id, before_json, after_json, group_key FROM undo_history WHERE group_key = ?1 ORDER BY id ASC",
        )
        .bind(gk)
        .fetch_all(&state.db)
        .await?;

        rows.iter()
            .map(|r| RedoEntry {
                id: r.get("id"),
                operation: r.get("operation"),
                node_id: r.get("node_id"),
                before_json: r.get("before_json"),
                after_json: r.get("after_json"),
                group_key: r.get("group_key"),
            })
            .collect()
    } else {
        vec![RedoEntry {
            id: next_row.get("id"),
            operation: operation.clone(),
            node_id: next_row.get("node_id"),
            before_json: next_row.get("before_json"),
            after_json: next_row.get("after_json"),
            group_key: next_row.get("group_key"),
        }]
    };

    if entries.is_empty() {
        return Ok(None);
    }

    let max_id = entries.iter().map(|e| e.id).max().unwrap_or(0);
    let mut node_ids: Vec<String> = Vec::new();

    // Apply each after_json (re-apply the operation).
    for entry in &entries {
        match entry.operation.as_str() {
            "delete" => {
                // After delete: node should be gone — delete it again.
                // No FK cascade since migration 0003 removed the FK constraint.
                sqlx::query("DELETE FROM nodes WHERE id = ?1")
                    .bind(&entry.node_id)
                    .execute(&state.db)
                    .await?;

                node_ids.push(entry.node_id.clone());
            }
            _ => {
                // For create, move, indent, outdent, text_edit: apply after snapshot.
                if entry.after_json != "{}" && !entry.after_json.is_empty() {
                    let restored_id = apply_node_snapshot(&state.db, &entry.after_json).await?;
                    node_ids.push(restored_id);
                } else {
                    node_ids.push(entry.node_id.clone());
                }
            }
        }
    }

    // Advance pointer to max_id of redone group.
    sqlx::query("UPDATE undo_pointer SET position = ?1 WHERE id = 1")
        .bind(max_id)
        .execute(&state.db)
        .await?;

    Ok(Some(UndoResult {
        node_ids,
        operation,
    }))
}
