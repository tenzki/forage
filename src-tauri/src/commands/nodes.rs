use chrono::Utc;
use sqlx::Row;
use tauri::State;
use uuid::Uuid;

use crate::AppState;
use crate::db::models::{Node, NodeType};
use crate::errors::AppError;

/// Map a sqlx Row to a Node struct.
/// Used by all query functions to avoid duplication.
fn map_row_to_node(row: &sqlx::sqlite::SqliteRow) -> Result<Node, AppError> {
    let content_str: String = row
        .try_get("content")
        .map_err(|e| AppError::Db(e.to_string()))?;
    let content: serde_json::Value = serde_json::from_str(&content_str)
        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

    let metadata_str: Option<String> = row
        .try_get("metadata")
        .map_err(|e| AppError::Db(e.to_string()))?;
    let metadata: Option<serde_json::Value> = metadata_str
        .as_deref()
        .map(|s| serde_json::from_str(s).unwrap_or(serde_json::Value::Null));

    Ok(Node {
        id: row.try_get("id").map_err(|e| AppError::Db(e.to_string()))?,
        parent_id: row
            .try_get("parent_id")
            .map_err(|e| AppError::Db(e.to_string()))?,
        position: row
            .try_get("position")
            .map_err(|e| AppError::Db(e.to_string()))?,
        content,
        node_type: row
            .try_get("node_type")
            .map_err(|e| AppError::Db(e.to_string()))?,
        collapsed: {
            let v: i64 = row
                .try_get("collapsed")
                .map_err(|e| AppError::Db(e.to_string()))?;
            v != 0
        },
        skill_id: row
            .try_get("skill_id")
            .map_err(|e| AppError::Db(e.to_string()))?,
        metadata,
        created_at: row
            .try_get("created_at")
            .map_err(|e| AppError::Db(e.to_string()))?,
        updated_at: row
            .try_get("updated_at")
            .map_err(|e| AppError::Db(e.to_string()))?,
    })
}

/// Create a new node in the tree.
///
/// Generates a UUID v4 id and current timestamp automatically.
/// `parent_id = None` creates a root node.
/// Returns the created node.
#[tauri::command]
#[specta::specta]
pub async fn create_node(
    state: State<'_, AppState>,
    parent_id: Option<String>,
    position: String,
    node_type: NodeType,
    content: serde_json::Value,
    metadata: Option<serde_json::Value>,
) -> Result<Node, AppError> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let node_type_str = node_type.to_db_str();
    let content_str =
        serde_json::to_string(&content).map_err(|e| AppError::InvalidInput(e.to_string()))?;
    let metadata_str = metadata
        .as_ref()
        .map(|m| serde_json::to_string(m))
        .transpose()
        .map_err(|e| AppError::InvalidInput(e.to_string()))?;

    sqlx::query(
        "INSERT INTO nodes (id, parent_id, position, content, node_type, collapsed, skill_id, metadata, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, ?7, ?8)",
    )
    .bind(&id)
    .bind(&parent_id)
    .bind(&position)
    .bind(&content_str)
    .bind(node_type_str)
    .bind(&metadata_str)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await?;

    get_node(state, id).await
}

/// Retrieve a single node by id.
///
/// Returns AppError::NotFound if the id does not exist in the database.
#[tauri::command]
#[specta::specta]
pub async fn get_node(state: State<'_, AppState>, id: String) -> Result<Node, AppError> {
    let row = sqlx::query("SELECT * FROM nodes WHERE id = ?1")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Node not found: {}", id)))?;

    map_row_to_node(&row)
}

/// Retrieve children of a given parent, ordered by position ASC.
///
/// `parent_id = None` returns root-level nodes.
/// Uses `IS` (not `=`) for NULL-safe comparison.
#[tauri::command]
#[specta::specta]
pub async fn get_children(
    state: State<'_, AppState>,
    parent_id: Option<String>,
) -> Result<Vec<Node>, AppError> {
    let rows = sqlx::query("SELECT * FROM nodes WHERE parent_id IS ?1 ORDER BY position ASC")
        .bind(&parent_id)
        .fetch_all(&state.db)
        .await?;

    rows.iter().map(map_row_to_node).collect()
}

/// Update mutable fields of an existing node.
///
/// All parameters except `id` are optional — only provided fields are updated.
/// Always updates `updated_at` to the current timestamp.
/// Returns the updated node.
#[tauri::command]
#[specta::specta]
pub async fn update_node(
    state: State<'_, AppState>,
    id: String,
    content: Option<serde_json::Value>,
    position: Option<String>,
    collapsed: Option<bool>,
    metadata: Option<serde_json::Value>,
) -> Result<Node, AppError> {
    // Verify the node exists before attempting update.
    let _ = get_node(State::clone(&state), id.clone()).await?;

    let now = Utc::now().to_rfc3339();

    let content_str = content
        .as_ref()
        .map(|c| serde_json::to_string(c))
        .transpose()
        .map_err(|e| AppError::InvalidInput(e.to_string()))?;

    let metadata_str = metadata
        .as_ref()
        .map(|m| serde_json::to_string(m))
        .transpose()
        .map_err(|e| AppError::InvalidInput(e.to_string()))?;

    // Build dynamic SET clause based on provided fields.
    let mut set_parts: Vec<&str> = vec!["updated_at = ?1"];
    if content_str.is_some() {
        set_parts.push("content = ?2");
    }
    if position.is_some() {
        set_parts.push("position = ?3");
    }
    if collapsed.is_some() {
        set_parts.push("collapsed = ?4");
    }
    if metadata_str.is_some() {
        set_parts.push("metadata = ?5");
    }

    let sql = format!(
        "UPDATE nodes SET {} WHERE id = ?6",
        set_parts.join(", ")
    );

    let collapsed_int = collapsed.map(|b| if b { 1i64 } else { 0i64 });

    sqlx::query(&sql)
        .bind(&now)
        .bind(&content_str)
        .bind(&position)
        .bind(&collapsed_int)
        .bind(&metadata_str)
        .bind(&id)
        .execute(&state.db)
        .await?;

    get_node(state, id).await
}

/// Move a node to a new parent and position atomically.
///
/// Changes `parent_id` and `position` in a single UPDATE statement.
/// `new_parent_id = None` moves the node to the root level.
/// Returns AppError::NotFound if the node does not exist.
#[tauri::command]
#[specta::specta]
pub async fn move_node(
    state: State<'_, AppState>,
    id: String,
    new_parent_id: Option<String>,
    new_position: String,
) -> Result<Node, AppError> {
    // Verify node exists first.
    let _ = get_node(State::clone(&state), id.clone()).await?;
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "UPDATE nodes SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
    )
    .bind(&new_parent_id)
    .bind(&new_position)
    .bind(&now)
    .bind(&id)
    .execute(&state.db)
    .await?;

    get_node(state, id).await
}

/// Delete a node by id.
///
/// CASCADE delete removes all descendant nodes automatically (schema-enforced).
/// Returns AppError::NotFound if the node does not exist.
#[tauri::command]
#[specta::specta]
pub async fn delete_node(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    // Verify existence before deletion so we can return NotFound.
    let _ = get_node(State::clone(&state), id.clone()).await?;

    sqlx::query("DELETE FROM nodes WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;

    Ok(())
}
