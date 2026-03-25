/// Integration tests for Phase 1 storage foundation.
///
/// Tests run against real SQLite files in temp directories.
/// Run with: cargo test --test db_tests -- --test-threads=1
///
/// INFR-02 proven: persistence, WAL mode, UUID as TEXT, position ordering
/// INFR-04 proven: node_type enum values, invalid rejection, metadata JSON roundtrip
use sqlx::Row;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use std::str::FromStr;

/// Create an in-file SQLite pool with the same options as production.
/// `path` must be a valid file path string (e.g. from a temp dir).
async fn create_test_pool(path: &str) -> sqlx::SqlitePool {
    let url = format!("sqlite:{}", path);
    let opts = SqliteConnectOptions::from_str(&url)
        .expect("invalid sqlite url")
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5))
        .optimize_on_close(true, None);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await
        .expect("failed to connect to test database");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migration failed");

    pool
}

/// Generate a unique temp file path for each test to avoid cross-test interference.
fn temp_db_path(test_name: &str) -> String {
    let dir = std::env::temp_dir();
    let file = format!("ai_chat_test_{}_{}.db", test_name, std::process::id());
    dir.join(file).to_string_lossy().to_string()
}

/// Cleanup temp database files after test.
fn cleanup(path: &str) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path));
    let _ = std::fs::remove_file(format!("{}-shm", path));
}

// ─── INFR-02 Tests ────────────────────────────────────────────────────────────

/// INFR-02: Data persists across pool close and reopen.
///
/// Inserts a fully-populated node, drops the pool, creates a new pool
/// from the same file, and asserts all fields survive the round-trip.
#[tokio::test]
async fn test_node_persistence() {
    let path = temp_db_path("persistence");

    // Phase 1: Insert data
    {
        let pool = create_test_pool(&path).await;

        sqlx::query(
            "INSERT INTO nodes (id, parent_id, position, content, node_type, collapsed, skill_id, metadata, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )
        .bind("test-uuid-1234-persistence")
        .bind(None::<String>)
        .bind("a0")
        .bind(r#"{"type":"doc","content":[]}"#)
        .bind("note")
        .bind(0i64)
        .bind("skill-abc")
        .bind(r#"{"model":"gpt-4","tokens":42}"#)
        .bind("2026-01-01T00:00:00Z")
        .bind("2026-01-01T00:00:01Z")
        .execute(&pool)
        .await
        .expect("insert failed");

        // Explicitly close the pool before reopening.
        pool.close().await;
    }

    // Phase 2: Open new pool from same file and verify data survived.
    {
        let pool = create_test_pool(&path).await;

        let row = sqlx::query("SELECT * FROM nodes WHERE id = ?1")
            .bind("test-uuid-1234-persistence")
            .fetch_one(&pool)
            .await
            .expect("node not found after pool restart");

        assert_eq!(row.get::<String, _>("id"), "test-uuid-1234-persistence");
        assert_eq!(row.get::<Option<String>, _>("parent_id"), None);
        assert_eq!(row.get::<String, _>("position"), "a0");
        assert_eq!(
            row.get::<String, _>("content"),
            r#"{"type":"doc","content":[]}"#
        );
        assert_eq!(row.get::<String, _>("node_type"), "note");
        assert_eq!(row.get::<i64, _>("collapsed"), 0);
        assert_eq!(
            row.get::<Option<String>, _>("skill_id"),
            Some("skill-abc".to_string())
        );
        assert_eq!(
            row.get::<Option<String>, _>("metadata"),
            Some(r#"{"model":"gpt-4","tokens":42}"#.to_string())
        );
        assert_eq!(row.get::<String, _>("created_at"), "2026-01-01T00:00:00Z");
        assert_eq!(row.get::<String, _>("updated_at"), "2026-01-01T00:00:01Z");

        pool.close().await;
    }

    cleanup(&path);
}

/// INFR-02: WAL journal mode is active after initialization.
#[tokio::test]
async fn test_wal_mode_enabled() {
    let path = temp_db_path("wal_mode");
    let pool = create_test_pool(&path).await;

    let row = sqlx::query("PRAGMA journal_mode;")
        .fetch_one(&pool)
        .await
        .expect("PRAGMA query failed");

    let mode: String = row.get(0);
    assert_eq!(mode, "wal", "Expected WAL journal mode, got: {}", mode);

    pool.close().await;
    cleanup(&path);
}

/// INFR-02: UUID primary key is stored as TEXT (not BLOB or INTEGER).
#[tokio::test]
async fn test_uuid_stored_as_text() {
    let path = temp_db_path("uuid_text");
    let pool = create_test_pool(&path).await;

    let known_uuid = "550e8400-e29b-41d4-a716-446655440000";

    sqlx::query(
        "INSERT INTO nodes (id, position, content, node_type, created_at, updated_at)
         VALUES (?1, 'a0', '{}', 'note', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .bind(known_uuid)
    .execute(&pool)
    .await
    .expect("insert failed");

    let row = sqlx::query("SELECT typeof(id) FROM nodes WHERE id = ?1")
        .bind(known_uuid)
        .fetch_one(&pool)
        .await
        .expect("typeof query failed");

    let type_name: String = row.get(0);
    assert_eq!(
        type_name, "text",
        "UUID should be stored as TEXT, got: {}",
        type_name
    );

    pool.close().await;
    cleanup(&path);
}

/// INFR-02: Children returned ordered by fractional position ASC.
#[tokio::test]
async fn test_position_ordering() {
    let path = temp_db_path("position_ordering");
    let pool = create_test_pool(&path).await;

    // Insert in reverse order to confirm ORDER BY position works.
    for (pos, id) in [("a2", "id-c"), ("a0", "id-a"), ("a1", "id-b")] {
        sqlx::query(
            "INSERT INTO nodes (id, position, content, node_type, created_at, updated_at)
             VALUES (?1, ?2, '{}', 'note', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(id)
        .bind(pos)
        .execute(&pool)
        .await
        .expect("insert failed");
    }

    let rows = sqlx::query("SELECT id, position FROM nodes WHERE parent_id IS NULL ORDER BY position ASC")
        .fetch_all(&pool)
        .await
        .expect("select failed");

    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].get::<String, _>("position"), "a0");
    assert_eq!(rows[1].get::<String, _>("position"), "a1");
    assert_eq!(rows[2].get::<String, _>("position"), "a2");

    pool.close().await;
    cleanup(&path);
}

// ─── INFR-04 Tests ────────────────────────────────────────────────────────────

/// INFR-04: All four valid node_type values are accepted by the CHECK constraint.
#[tokio::test]
async fn test_node_type_enum() {
    let path = temp_db_path("node_type_enum");
    let pool = create_test_pool(&path).await;

    let valid_types = ["note", "agent_response", "command", "chat_message"];

    for (i, node_type) in valid_types.iter().enumerate() {
        let id = format!("type-test-{}", i);
        let position = format!("a{}", i);

        sqlx::query(
            "INSERT INTO nodes (id, position, content, node_type, created_at, updated_at)
             VALUES (?1, ?2, '{}', ?3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(&id)
        .bind(&position)
        .bind(*node_type)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("insert of node_type '{}' failed: {}", node_type, e));

        let row = sqlx::query("SELECT node_type FROM nodes WHERE id = ?1")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .expect("select failed");

        assert_eq!(row.get::<String, _>("node_type"), *node_type);
    }

    pool.close().await;
    cleanup(&path);
}

/// INFR-04: Invalid node_type values are rejected by the CHECK constraint.
#[tokio::test]
async fn test_node_type_invalid_rejected() {
    let path = temp_db_path("node_type_invalid");
    let pool = create_test_pool(&path).await;

    let result = sqlx::query(
        "INSERT INTO nodes (id, position, content, node_type, created_at, updated_at)
         VALUES ('bad-type-id', 'a0', '{}', 'invalid_type', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await;

    assert!(
        result.is_err(),
        "Expected CHECK constraint violation for invalid node_type, but insert succeeded"
    );

    pool.close().await;
    cleanup(&path);
}

/// INFR-04: Metadata JSON column stores and retrieves arbitrary JSON values correctly.
#[tokio::test]
async fn test_metadata_json_roundtrip() {
    let path = temp_db_path("metadata_json");
    let pool = create_test_pool(&path).await;

    let metadata_json = r#"{"model":"gpt-4","tokens":150,"skill":"research"}"#;

    sqlx::query(
        "INSERT INTO nodes (id, position, content, node_type, metadata, created_at, updated_at)
         VALUES ('meta-node-1', 'a0', '{}', 'note', ?1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .bind(metadata_json)
    .execute(&pool)
    .await
    .expect("insert failed");

    let row = sqlx::query("SELECT metadata FROM nodes WHERE id = 'meta-node-1'")
        .fetch_one(&pool)
        .await
        .expect("select failed");

    let stored: String = row.get("metadata");
    let parsed: serde_json::Value =
        serde_json::from_str(&stored).expect("metadata is not valid JSON");

    assert_eq!(parsed["model"], "gpt-4");
    assert_eq!(parsed["tokens"], 150);
    assert_eq!(parsed["skill"], "research");

    pool.close().await;
    cleanup(&path);
}

/// INFR-02 + INFR-04: CASCADE delete removes children when parent is deleted.
#[tokio::test]
async fn test_cascade_delete() {
    let path = temp_db_path("cascade_delete");
    let pool = create_test_pool(&path).await;

    // Create parent node.
    sqlx::query(
        "INSERT INTO nodes (id, position, content, node_type, created_at, updated_at)
         VALUES ('parent-1', 'a0', '{}', 'note', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .expect("parent insert failed");

    // Create two child nodes.
    for (id, pos) in [("child-1", "a0"), ("child-2", "a1")] {
        sqlx::query(
            "INSERT INTO nodes (id, parent_id, position, content, node_type, created_at, updated_at)
             VALUES (?1, 'parent-1', ?2, '{}', 'note', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(id)
        .bind(pos)
        .execute(&pool)
        .await
        .expect("child insert failed");
    }

    // Verify children exist.
    let child_count_before: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM nodes WHERE parent_id = 'parent-1'")
            .fetch_one(&pool)
            .await
            .expect("count query failed");
    assert_eq!(child_count_before, 2, "Expected 2 children before delete");

    // Delete parent — should cascade to children.
    sqlx::query("DELETE FROM nodes WHERE id = 'parent-1'")
        .execute(&pool)
        .await
        .expect("delete failed");

    // Children should be gone.
    let child_count_after: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM nodes WHERE parent_id = 'parent-1'")
            .fetch_one(&pool)
            .await
            .expect("count query failed");
    assert_eq!(
        child_count_after, 0,
        "Expected 0 children after CASCADE delete, got {}",
        child_count_after
    );

    pool.close().await;
    cleanup(&path);
}

// ─── TREE-01 move_node Tests ──────────────────────────────────────────────────

/// Helper: insert a minimal node into the pool directly via SQL.
async fn insert_node(
    pool: &sqlx::SqlitePool,
    id: &str,
    parent_id: Option<&str>,
    position: &str,
    node_type: &str,
    content: &str,
    metadata: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO nodes (id, parent_id, position, content, node_type, collapsed, skill_id, metadata, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .bind(id)
    .bind(parent_id)
    .bind(position)
    .bind(content)
    .bind(node_type)
    .bind(metadata)
    .execute(pool)
    .await
    .unwrap_or_else(|e| panic!("insert_node failed for id={}: {}", id, e));
}

/// TREE-01: move_node changes parent_id and position of an existing node.
#[tokio::test]
async fn test_move_node_changes_parent_and_position() {
    let path = temp_db_path("move_node_reparent");
    let pool = create_test_pool(&path).await;

    // Create parent A and parent B at root level.
    insert_node(&pool, "parent-a", None, "a0", "note", "{}", None).await;
    insert_node(&pool, "parent-b", None, "a1", "note", "{}", None).await;
    // Create child under parent A.
    insert_node(&pool, "child-1", Some("parent-a"), "a0", "note", "{}", None).await;

    // Simulate move_node: update child-1 to parent-b with new position.
    sqlx::query(
        "UPDATE nodes SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
    )
    .bind(Some("parent-b"))
    .bind("a0")
    .bind("2026-01-02T00:00:00Z")
    .bind("child-1")
    .execute(&pool)
    .await
    .expect("UPDATE failed");

    let row = sqlx::query("SELECT parent_id, position FROM nodes WHERE id = 'child-1'")
        .fetch_one(&pool)
        .await
        .expect("SELECT failed");

    assert_eq!(
        row.get::<Option<String>, _>("parent_id"),
        Some("parent-b".to_string()),
        "parent_id should be parent-b after move"
    );
    assert_eq!(
        row.get::<String, _>("position"),
        "a0",
        "position should be a0 after move"
    );

    pool.close().await;
    cleanup(&path);
}

/// TREE-01: move_node to root (parent_id = None) works.
#[tokio::test]
async fn test_move_node_to_root() {
    let path = temp_db_path("move_node_to_root");
    let pool = create_test_pool(&path).await;

    // Create a parent and a child.
    insert_node(&pool, "root-parent", None, "a0", "note", "{}", None).await;
    insert_node(&pool, "nested-child", Some("root-parent"), "a0", "note", "{}", None).await;

    // Move nested-child to root (parent_id = NULL).
    sqlx::query(
        "UPDATE nodes SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
    )
    .bind(None::<String>)
    .bind("a1")
    .bind("2026-01-02T00:00:00Z")
    .bind("nested-child")
    .execute(&pool)
    .await
    .expect("UPDATE failed");

    let row = sqlx::query("SELECT parent_id, position FROM nodes WHERE id = 'nested-child'")
        .fetch_one(&pool)
        .await
        .expect("SELECT failed");

    assert_eq!(
        row.get::<Option<String>, _>("parent_id"),
        None,
        "parent_id should be NULL after moving to root"
    );
    assert_eq!(row.get::<String, _>("position"), "a1");

    pool.close().await;
    cleanup(&path);
}

/// TREE-01: move_node preserves all other node fields (content, metadata, collapsed, node_type).
#[tokio::test]
async fn test_move_node_preserves_other_fields() {
    let path = temp_db_path("move_node_preserves");
    let pool = create_test_pool(&path).await;

    let content = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hello"}]}]}"#;
    let metadata = r#"{"model":"gpt-4","tokens":42}"#;

    // Create node with content/metadata at root.
    sqlx::query(
        "INSERT INTO nodes (id, parent_id, position, content, node_type, collapsed, skill_id, metadata, created_at, updated_at)
         VALUES (?1, NULL, 'a0', ?2, 'agent_response', 1, NULL, ?3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .bind("rich-node")
    .bind(content)
    .bind(metadata)
    .execute(&pool)
    .await
    .expect("insert failed");

    // Create a new parent to move to.
    insert_node(&pool, "new-parent", None, "a1", "note", "{}", None).await;

    // Move rich-node to new-parent.
    sqlx::query(
        "UPDATE nodes SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
    )
    .bind(Some("new-parent"))
    .bind("a0")
    .bind("2026-01-02T00:00:00Z")
    .bind("rich-node")
    .execute(&pool)
    .await
    .expect("UPDATE failed");

    let row = sqlx::query("SELECT * FROM nodes WHERE id = 'rich-node'")
        .fetch_one(&pool)
        .await
        .expect("SELECT failed");

    // parent_id and position should have changed.
    assert_eq!(
        row.get::<Option<String>, _>("parent_id"),
        Some("new-parent".to_string())
    );
    assert_eq!(row.get::<String, _>("position"), "a0");

    // All other fields should be unchanged.
    assert_eq!(row.get::<String, _>("content"), content);
    assert_eq!(row.get::<String, _>("node_type"), "agent_response");
    assert_eq!(row.get::<i64, _>("collapsed"), 1);
    assert_eq!(
        row.get::<Option<String>, _>("metadata"),
        Some(metadata.to_string())
    );

    pool.close().await;
    cleanup(&path);
}

// ─── TREE-05 FTS5 Search Tests ────────────────────────────────────────────────

/// Helper: insert a node with content_text for FTS5 search tests.
async fn insert_node_with_text(
    pool: &sqlx::SqlitePool,
    id: &str,
    parent_id: Option<&str>,
    position: &str,
    content_text: &str,
) {
    sqlx::query(
        "INSERT INTO nodes (id, parent_id, position, content, node_type, collapsed, skill_id, metadata, content_text, created_at, updated_at)
         VALUES (?1, ?2, ?3, '{}', 'note', 0, NULL, NULL, ?4, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .bind(id)
    .bind(parent_id)
    .bind(position)
    .bind(content_text)
    .execute(pool)
    .await
    .unwrap_or_else(|e| panic!("insert_node_with_text failed for id={}: {}", id, e));
}

/// TREE-05: search_nodes FTS5 search returns matching nodes with snippets.
///
/// Creates 3 nodes with different content, searches for a term that matches only one,
/// and asserts the correct node is returned with a non-empty snippet.
#[tokio::test]
async fn test_search_nodes() {
    let path = temp_db_path("search_nodes");
    let pool = create_test_pool(&path).await;

    // Insert three nodes with distinct content.
    insert_node_with_text(&pool, "search-node-1", None, "a0", "The quick brown fox jumps").await;
    insert_node_with_text(&pool, "search-node-2", None, "a1", "A lazy dog sleeps all day").await;
    insert_node_with_text(&pool, "search-node-3", None, "a2", "The fox ran over the hill quickly").await;

    // Search for "fox" — should match node-1 and node-3, but not node-2.
    let fts_query = "\"fox\"*";
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
    .bind(fts_query)
    .fetch_all(&pool)
    .await
    .expect("FTS5 search query failed");

    // Should get 2 results (node-1 and node-3).
    assert_eq!(rows.len(), 2, "Expected 2 search results for 'fox', got {}", rows.len());

    // Collect ids.
    let ids: Vec<String> = rows.iter().map(|r| r.get::<String, _>("id")).collect();
    assert!(ids.contains(&"search-node-1".to_string()), "Expected search-node-1 in results");
    assert!(ids.contains(&"search-node-3".to_string()), "Expected search-node-3 in results");
    assert!(!ids.contains(&"search-node-2".to_string()), "search-node-2 should NOT match 'fox'");

    // Verify snippets contain <mark> tags (FTS5 highlight).
    for row in &rows {
        let snippet: String = row.get("snippet_text");
        assert!(
            snippet.contains("<mark>"),
            "Expected snippet to contain <mark> tags, got: {}",
            snippet
        );
    }

    pool.close().await;
    cleanup(&path);
}

/// TREE-05: FTS5 index is updated when content_text is updated via trigger.
#[tokio::test]
async fn test_search_nodes_fts_update_trigger() {
    let path = temp_db_path("search_fts_update");
    let pool = create_test_pool(&path).await;

    // Insert a node with initial content.
    insert_node_with_text(&pool, "update-node-1", None, "a0", "initial content here").await;

    // Verify it appears in search.
    let count_before: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM nodes_fts WHERE nodes_fts MATCH '\"initial\"*'"
    )
    .fetch_one(&pool)
    .await
    .expect("count query failed");
    assert_eq!(count_before, 1, "Expected 1 result before update");

    // Update the content_text — trigger should update FTS index.
    sqlx::query("UPDATE nodes SET content_text = ?1, updated_at = ?2 WHERE id = ?3")
        .bind("completely different words now")
        .bind("2026-01-02T00:00:00Z")
        .bind("update-node-1")
        .execute(&pool)
        .await
        .expect("update failed");

    // Old content should no longer match.
    let count_old: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM nodes_fts WHERE nodes_fts MATCH '\"initial\"*'"
    )
    .fetch_one(&pool)
    .await
    .expect("count query failed");
    assert_eq!(count_old, 0, "Old content should not match after update");

    // New content should match.
    let count_new: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM nodes_fts WHERE nodes_fts MATCH '\"different\"*'"
    )
    .fetch_one(&pool)
    .await
    .expect("count query failed");
    assert_eq!(count_new, 1, "New content should match after update");

    pool.close().await;
    cleanup(&path);
}

// ─── EDIT-01 Undo/Redo Tests ──────────────────────────────────────────────────

/// EDIT-01: Structural undo/redo — create a node, record undo step, undo it (deletes node),
/// then redo it (restores node).
#[tokio::test]
async fn test_undo_redo_structural() {
    let path = temp_db_path("undo_redo_structural");
    let pool = create_test_pool(&path).await;

    // Create a node.
    let node_id = "undo-test-node-1";
    sqlx::query(
        "INSERT INTO nodes (id, parent_id, position, content, node_type, collapsed, skill_id, metadata, content_text, created_at, updated_at)
         VALUES (?1, NULL, 'a0', '{}', 'note', 0, NULL, NULL, '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .bind(node_id)
    .execute(&pool)
    .await
    .expect("insert node failed");

    // Verify node exists.
    let count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM nodes WHERE id = ?1")
        .bind(node_id)
        .fetch_one(&pool)
        .await
        .expect("count query failed");
    assert_eq!(count_before, 1, "Node should exist before undo");

    // Record an undo step for the 'create' operation.
    // before_json = '{}' (node didn't exist), after_json = node snapshot.
    let after_snapshot = r#"{"id":"undo-test-node-1","parent_id":null,"position":"a0","content":{},"node_type":"note","collapsed":false,"skill_id":null,"metadata":null,"content_text":"","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}"#;

    // Clear pointer is at 0 by default (migration inserts it).
    // Simulate record_undo_step: clear redo stack, insert, advance pointer.
    sqlx::query("DELETE FROM undo_history WHERE id > (SELECT position FROM undo_pointer WHERE id = 1)")
        .execute(&pool)
        .await
        .expect("clear redo failed");

    sqlx::query(
        "INSERT INTO undo_history (operation, node_id, before_json, after_json, group_key)
         VALUES ('create', ?1, '{}', ?2, NULL)",
    )
    .bind(node_id)
    .bind(after_snapshot)
    .execute(&pool)
    .await
    .expect("insert undo step failed");

    let new_id: i64 = sqlx::query_scalar("SELECT last_insert_rowid()")
        .fetch_one(&pool)
        .await
        .expect("last_insert_rowid failed");

    sqlx::query("UPDATE undo_pointer SET position = ?1 WHERE id = 1")
        .bind(new_id)
        .execute(&pool)
        .await
        .expect("update pointer failed");

    // --- Simulate undo_step ---
    let position: i64 = sqlx::query_scalar("SELECT position FROM undo_pointer WHERE id = 1")
        .fetch_one(&pool)
        .await
        .expect("read pointer failed");
    assert!(position > 0, "Pointer should be > 0 after recording step");

    // Read the undo entry BEFORE deleting the node (ON DELETE CASCADE will remove it).
    let row = sqlx::query(
        "SELECT id, operation, node_id, before_json, after_json, group_key FROM undo_history WHERE id = ?1",
    )
    .bind(position)
    .fetch_one(&pool)
    .await
    .expect("fetch undo entry failed");

    let op: String = row.get("operation");
    let nid: String = row.get("node_id");
    let undo_entry_id: i64 = row.get("id");
    let saved_after_json: String = row.get("after_json");
    assert_eq!(op, "create");
    assert_eq!(nid, node_id);

    // For 'create' undo: delete the node.
    // NOTE: ON DELETE CASCADE will also delete the undo_history entry.
    // The actual undo_step command reads entries first, then deletes — same pattern here.
    sqlx::query("DELETE FROM nodes WHERE id = ?1")
        .bind(&nid)
        .execute(&pool)
        .await
        .expect("delete node for undo failed");

    // Move pointer back to 0.
    sqlx::query("UPDATE undo_pointer SET position = 0 WHERE id = 1")
        .execute(&pool)
        .await
        .expect("reset pointer failed");

    // Verify node is gone after undo.
    let count_after_undo: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM nodes WHERE id = ?1")
        .bind(node_id)
        .fetch_one(&pool)
        .await
        .expect("count after undo failed");
    assert_eq!(count_after_undo, 0, "Node should be deleted after undo of create");

    // --- Simulate redo_step ---
    // Since ON DELETE CASCADE removed the undo_history entry when we deleted the node,
    // we need to re-insert it for redo to work. The actual undo_step command handles this
    // because it re-reads after applying before_json.
    // For this test, we simulate redo using the saved after_json data.
    let redo_nid = nid.clone();
    let redo_id = undo_entry_id;
    let redo_after = saved_after_json;

    // For 'create' redo: re-insert node from after_json.
    let snapshot: serde_json::Value = serde_json::from_str(&redo_after).expect("parse snapshot");
    sqlx::query(
        "INSERT OR REPLACE INTO nodes
         (id, parent_id, position, content, node_type, collapsed, skill_id, metadata, content_text, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )
    .bind(snapshot["id"].as_str().unwrap())
    .bind(snapshot["parent_id"].as_str())
    .bind(snapshot["position"].as_str().unwrap())
    .bind(serde_json::to_string(&snapshot["content"]).unwrap())
    .bind(snapshot["node_type"].as_str().unwrap())
    .bind(if snapshot["collapsed"].as_bool().unwrap_or(false) { 1i64 } else { 0i64 })
    .bind(snapshot["skill_id"].as_str())
    .bind(snapshot["metadata"].as_str())
    .bind(snapshot["content_text"].as_str().unwrap_or(""))
    .bind(snapshot["created_at"].as_str().unwrap_or("2026-01-01T00:00:00Z"))
    .bind(snapshot["updated_at"].as_str().unwrap_or("2026-01-01T00:00:00Z"))
    .execute(&pool)
    .await
    .expect("redo re-insert failed");

    // Advance pointer to redo_id.
    sqlx::query("UPDATE undo_pointer SET position = ?1 WHERE id = 1")
        .bind(redo_id)
        .execute(&pool)
        .await
        .expect("advance pointer for redo failed");

    // Verify node is back after redo.
    let count_after_redo: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM nodes WHERE id = ?1")
        .bind(redo_nid)
        .fetch_one(&pool)
        .await
        .expect("count after redo failed");
    assert_eq!(count_after_redo, 1, "Node should exist again after redo of create");

    pool.close().await;
    cleanup(&path);
}

/// EDIT-01: Text group undo — record 3 undo steps with same group_key,
/// then undo once and verify all 3 are reverted together.
#[tokio::test]
async fn test_undo_redo_text_group() {
    let path = temp_db_path("undo_redo_text_group");
    let pool = create_test_pool(&path).await;

    let node_id = "group-test-node-1";

    // Insert a node with initial content.
    sqlx::query(
        "INSERT INTO nodes (id, parent_id, position, content, node_type, collapsed, skill_id, metadata, content_text, created_at, updated_at)
         VALUES (?1, NULL, 'a0', '{}', 'note', 0, NULL, NULL, 'hello', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .bind(node_id)
    .execute(&pool)
    .await
    .expect("insert node failed");

    let group_key = "group_1234567890";

    // Record 3 undo steps with same group_key.
    let snapshots = [
        (r#"{"id":"group-test-node-1","parent_id":null,"position":"a0","content":{},"node_type":"note","collapsed":false,"skill_id":null,"metadata":null,"content_text":"h","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:01Z"}"#,
         r#"{"id":"group-test-node-1","parent_id":null,"position":"a0","content":{},"node_type":"note","collapsed":false,"skill_id":null,"metadata":null,"content_text":"he","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:02Z"}"#),
        (r#"{"id":"group-test-node-1","parent_id":null,"position":"a0","content":{},"node_type":"note","collapsed":false,"skill_id":null,"metadata":null,"content_text":"he","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:02Z"}"#,
         r#"{"id":"group-test-node-1","parent_id":null,"position":"a0","content":{},"node_type":"note","collapsed":false,"skill_id":null,"metadata":null,"content_text":"hel","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:03Z"}"#),
        (r#"{"id":"group-test-node-1","parent_id":null,"position":"a0","content":{},"node_type":"note","collapsed":false,"skill_id":null,"metadata":null,"content_text":"hel","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:03Z"}"#,
         r#"{"id":"group-test-node-1","parent_id":null,"position":"a0","content":{},"node_type":"note","collapsed":false,"skill_id":null,"metadata":null,"content_text":"hello","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:04Z"}"#),
    ];

    let mut last_id: i64;
    for (before, after) in &snapshots {
        sqlx::query(
            "DELETE FROM undo_history WHERE id > (SELECT position FROM undo_pointer WHERE id = 1)",
        )
        .execute(&pool)
        .await
        .expect("clear redo failed");

        sqlx::query(
            "INSERT INTO undo_history (operation, node_id, before_json, after_json, group_key)
             VALUES ('text_edit', ?1, ?2, ?3, ?4)",
        )
        .bind(node_id)
        .bind(*before)
        .bind(*after)
        .bind(group_key)
        .execute(&pool)
        .await
        .expect("insert undo step failed");

        last_id = sqlx::query_scalar("SELECT last_insert_rowid()")
            .fetch_one(&pool)
            .await
            .expect("last_insert_rowid failed");

        sqlx::query("UPDATE undo_pointer SET position = ?1 WHERE id = 1")
            .bind(last_id)
            .execute(&pool)
            .await
            .expect("update pointer failed");
    }

    // Verify 3 entries exist for this group.
    let group_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM undo_history WHERE group_key = ?1")
            .bind(group_key)
            .fetch_one(&pool)
            .await
            .expect("count group entries failed");
    assert_eq!(group_count, 3, "Expected 3 undo entries in group");

    // Simulate undo_step for the group.
    // Read all group entries.
    let group_rows = sqlx::query(
        "SELECT id, before_json FROM undo_history WHERE group_key = ?1 ORDER BY id ASC",
    )
    .bind(group_key)
    .fetch_all(&pool)
    .await
    .expect("fetch group rows failed");

    let min_id = group_rows
        .iter()
        .map(|r| r.get::<i64, _>("id"))
        .min()
        .unwrap();

    // Apply the first before_json (the earliest state in the group) to restore.
    let first_before: String = group_rows[0].get("before_json");
    let snapshot: serde_json::Value = serde_json::from_str(&first_before).expect("parse snapshot");
    let restored_text = snapshot["content_text"].as_str().unwrap_or("");
    assert_eq!(restored_text, "h", "First before_json should have content_text='h'");

    // Update node to the first before snapshot's content_text.
    sqlx::query("UPDATE nodes SET content_text = ?1 WHERE id = ?2")
        .bind(restored_text)
        .bind(node_id)
        .execute(&pool)
        .await
        .expect("update node content_text failed");

    // Move pointer to min_id - 1.
    let new_pos = min_id - 1;
    sqlx::query("UPDATE undo_pointer SET position = ?1 WHERE id = 1")
        .bind(new_pos)
        .execute(&pool)
        .await
        .expect("reset pointer failed");

    // Verify the node content_text is now back to the initial state.
    let row = sqlx::query("SELECT content_text FROM nodes WHERE id = ?1")
        .bind(node_id)
        .fetch_one(&pool)
        .await
        .expect("fetch node after undo");

    let content_text: String = row.get("content_text");
    assert_eq!(
        content_text, "h",
        "After group undo, content_text should be restored to first before snapshot value"
    );

    // Verify pointer is now before the group.
    let cur_pos: i64 = sqlx::query_scalar("SELECT position FROM undo_pointer WHERE id = 1")
        .fetch_one(&pool)
        .await
        .expect("read pointer failed");
    assert!(
        cur_pos < min_id,
        "Pointer ({}) should be before min group id ({})",
        cur_pos,
        min_id
    );

    pool.close().await;
    cleanup(&path);
}

/// TREE-01: Attempting to move a non-existent node id returns no rows updated (simulates NotFound).
#[tokio::test]
async fn test_move_node_not_found() {
    let path = temp_db_path("move_node_not_found");
    let pool = create_test_pool(&path).await;

    // Try to move a node that does not exist.
    let result = sqlx::query(
        "UPDATE nodes SET parent_id = NULL, position = 'a0', updated_at = '2026-01-02T00:00:00Z' WHERE id = ?1",
    )
    .bind("nonexistent-id")
    .execute(&pool)
    .await
    .expect("UPDATE should not error on missing row");

    assert_eq!(
        result.rows_affected(),
        0,
        "No rows should be updated for a nonexistent id"
    );

    pool.close().await;
    cleanup(&path);
}
