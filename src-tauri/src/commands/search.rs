use serde::Serialize;
use sqlx::Row;
use tauri::State;

use crate::AppState;
use crate::errors::AppError;

/// A search result returned by the FTS5 search query.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub parent_id: Option<String>,
    pub node_type: String,
    /// FTS5 snippet with <mark>...</mark> HTML tags around matches.
    pub snippet: String,
}

/// A single ancestor node for breadcrumb display.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AncestorNode {
    pub id: String,
    pub name: String,
}

/// Search nodes using FTS5 full-text search.
///
/// Uses runtime sqlx::query() (NOT the query! macro) because FTS5 virtual tables
/// are not introspectable at compile time.
///
/// Formats query as "{query}*" for prefix matching.
/// Joins nodes_fts to nodes via rowid (NOT id — FTS5 uses integer rowid).
/// Returns up to 20 results ordered by BM25 rank.
#[tauri::command]
#[specta::specta]
pub async fn search_nodes(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchResult>, AppError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }

    // Escape special FTS5 characters and append * for prefix matching.
    let fts_query = format!("\"{}\"*", trimmed.replace('"', "\"\""));

    let rows = sqlx::query(
        r#"
        SELECT
            n.id,
            n.parent_id,
            n.node_type,
            snippet(nodes_fts, 0, '<mark>', '</mark>', '...', 20) AS snippet_text
        FROM nodes_fts
        JOIN nodes n ON n.rowid = nodes_fts.rowid
        WHERE nodes_fts MATCH ?1
        ORDER BY rank
        LIMIT 20
        "#,
    )
    .bind(&fts_query)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::Db(e.to_string()))?;

    let results = rows
        .iter()
        .map(|row| {
            Ok(SearchResult {
                id: row.try_get("id").map_err(|e| AppError::Db(e.to_string()))?,
                parent_id: row
                    .try_get("parent_id")
                    .map_err(|e| AppError::Db(e.to_string()))?,
                node_type: row
                    .try_get("node_type")
                    .map_err(|e| AppError::Db(e.to_string()))?,
                snippet: row
                    .try_get("snippet_text")
                    .map_err(|e| AppError::Db(e.to_string()))?,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;

    Ok(results)
}

/// Get ancestors of a node for breadcrumb display.
///
/// Walks the parent_id chain up to the root, returning an ordered list
/// from root to the node's direct parent (excluding the node itself).
#[tauri::command]
#[specta::specta]
pub async fn get_ancestors(
    state: State<'_, AppState>,
    node_id: String,
) -> Result<Vec<AncestorNode>, AppError> {
    let mut ancestors: Vec<AncestorNode> = Vec::new();
    let mut current_id: Option<String> = Some(node_id.clone());

    // Walk up the parent chain.
    // We skip the target node itself — only ancestors are returned.
    let mut is_first = true;
    while let Some(id) = current_id {
        let row = sqlx::query("SELECT id, parent_id, content_text FROM nodes WHERE id = ?1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| AppError::Db(e.to_string()))?;

        match row {
            None => break,
            Some(r) => {
                let name: String = r
                    .try_get("content_text")
                    .map_err(|e| AppError::Db(e.to_string()))?;
                let parent: Option<String> = r
                    .try_get("parent_id")
                    .map_err(|e| AppError::Db(e.to_string()))?;

                if !is_first {
                    // Insert at front to maintain root-to-parent order.
                    ancestors.insert(
                        0,
                        AncestorNode {
                            id: id.clone(),
                            name: if name.is_empty() {
                                "Untitled".to_string()
                            } else {
                                name
                            },
                        },
                    );
                }
                is_first = false;
                current_id = parent;
            }
        }
    }

    Ok(ancestors)
}
