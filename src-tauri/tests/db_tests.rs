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
