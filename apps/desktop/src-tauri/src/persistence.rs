use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

const MIGRATION: &str = include_str!("../migrations/0001_event_store.sql");

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("SQLite event store failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("event store lock was poisoned")]
    Poisoned,
    #[error("event id {0} was reused with different content")]
    EventIdConflict(String),
    #[error("invalid storage mode {0}")]
    InvalidStorageMode(String),
}

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub id: String,
    pub outline_id: String,
    pub base_revision: i64,
    pub server_revision: Option<i64>,
    pub envelope: Value,
    pub status: String,
    pub superseded_by: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    pub local_sequence: i64,
    #[serde(flatten)]
    pub record: EventRecord,
}

impl std::ops::Deref for StoredEvent {
    type Target = EventRecord;
    fn deref(&self) -> &Self::Target {
        &self.record
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRecord {
    pub id: String,
    pub outline_id: String,
    pub document_version: i64,
    pub schema_epoch: i64,
    pub local_sequence: i64,
    pub server_revision: i64,
    pub state_json: String,
    pub integrity_hash: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub outline_id: String,
    pub last_acked_revision: i64,
    pub last_pulled_revision: i64,
    pub server_instance_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageMode {
    Local,
    Server,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfiguration {
    pub origin: String,
    pub instance_id: String,
    pub credential_reference: String,
    pub outline_id: String,
}

impl StorageMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Server => "server",
        }
    }
}

pub struct EventStore {
    connection: Mutex<Connection>,
}

impl EventStore {
    pub fn open(path: impl AsRef<Path>) -> StoreResult<Self> {
        let connection = Connection::open(path)?;
        Self::initialize(connection, true)
    }

    pub fn open_in_memory() -> StoreResult<Self> {
        Self::initialize(Connection::open_in_memory()?, false)
    }

    fn initialize(connection: Connection, enable_wal: bool) -> StoreResult<Self> {
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        if enable_wal {
            connection.pragma_update(None, "journal_mode", "WAL")?;
            connection.pragma_update(None, "synchronous", "NORMAL")?;
        }
        connection.execute_batch(MIGRATION)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn connection(&self) -> StoreResult<MutexGuard<'_, Connection>> {
        self.connection.lock().map_err(|_| StoreError::Poisoned)
    }

    pub fn append(&self, event: &EventRecord) -> StoreResult<i64> {
        let envelope_json = serde_json::to_string(&event.envelope)
            .expect("serde_json::Value serialization cannot fail");
        let connection = self.connection()?;
        let inserted = connection.execute(
            "INSERT OR IGNORE INTO outline_events
             (id, outline_id, base_revision, server_revision, envelope_json, status, superseded_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![event.id, event.outline_id, event.base_revision, event.server_revision,
                envelope_json, event.status, event.superseded_by, event.created_at],
        )?;
        if inserted == 0 {
            let existing: String = connection.query_row(
                "SELECT envelope_json FROM outline_events WHERE id = ?1",
                [&event.id],
                |row| row.get(0),
            )?;
            if existing != envelope_json {
                return Err(StoreError::EventIdConflict(event.id.clone()));
            }
        }
        connection
            .query_row(
                "SELECT local_sequence FROM outline_events WHERE id = ?1",
                [&event.id],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
    }

    pub fn commit_rebase(
        &self,
        outline_id: &str,
        pulled_events: &[EventRecord],
        replacements: &[(String, EventRecord)],
        pulled_revision: i64,
        acknowledgements: &[(&str, i64)],
    ) -> StoreResult<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for event in pulled_events {
            append_event(&transaction, event)?;
        }
        for (original_id, replacement) in replacements {
            append_event(&transaction, replacement)?;
            transaction.execute(
                "UPDATE outline_events SET superseded_by = ?2
                 WHERE id = ?1 AND status = 'pending'
                   AND (superseded_by IS NULL OR superseded_by = ?2)",
                params![original_id, replacement.id],
            )?;
        }
        let mut highest_acked = 0;
        for (event_id, revision) in acknowledgements {
            transaction.execute(
                "UPDATE outline_events
                 SET status = 'accepted', server_revision = ?3
                 WHERE id = ?1 AND outline_id = ?2
                   AND (server_revision IS NULL OR server_revision = ?3)",
                params![event_id, outline_id, revision],
            )?;
            highest_acked = highest_acked.max(*revision);
        }
        transaction.execute(
            "INSERT INTO outline_sync_state(outline_id, last_acked_revision, last_pulled_revision)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(outline_id) DO UPDATE SET
               last_acked_revision = MAX(last_acked_revision, excluded.last_acked_revision),
               last_pulled_revision = MAX(last_pulled_revision, excluded.last_pulled_revision),
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![outline_id, highest_acked, pulled_revision.max(0)],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn event(&self, id: &str) -> StoreResult<Option<StoredEvent>> {
        self.connection()?
            .query_row(
                "SELECT local_sequence, id, outline_id, base_revision, server_revision,
                    envelope_json, status, superseded_by, created_at
             FROM outline_events WHERE id = ?1",
                [id],
                row_to_event,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn events_after_sequence(
        &self,
        outline_id: &str,
        sequence: i64,
    ) -> StoreResult<Vec<StoredEvent>> {
        self.query_events(
            "SELECT local_sequence, id, outline_id, base_revision, server_revision,
                    envelope_json, status, superseded_by, created_at
             FROM outline_events WHERE outline_id = ?1 AND local_sequence > ?2
             ORDER BY local_sequence ASC",
            params![outline_id, sequence],
        )
    }

    pub fn pending_events(&self, outline_id: &str, limit: i64) -> StoreResult<Vec<StoredEvent>> {
        self.query_events(
            "SELECT local_sequence, id, outline_id, base_revision, server_revision,
                    envelope_json, status, superseded_by, created_at
             FROM outline_events
             WHERE outline_id = ?1 AND status = 'pending' AND superseded_by IS NULL
             ORDER BY local_sequence ASC LIMIT ?2",
            params![outline_id, limit.clamp(1, 1000)],
        )
    }

    fn query_events<P: rusqlite::Params>(
        &self,
        sql: &str,
        params: P,
    ) -> StoreResult<Vec<StoredEvent>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map(params, row_to_event)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn supersede(&self, event_id: &str, replacement_id: &str) -> StoreResult<()> {
        self.connection()?.execute(
            "UPDATE outline_events SET superseded_by = ?2
             WHERE id = ?1 AND status = 'pending' AND superseded_by IS NULL",
            params![event_id, replacement_id],
        )?;
        Ok(())
    }

    pub fn acknowledge_batch(
        &self,
        outline_id: &str,
        acknowledgements: &[(&str, i64)],
    ) -> StoreResult<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut highest = 0;
        for (event_id, revision) in acknowledgements {
            transaction.execute(
                "UPDATE outline_events
                 SET status = 'accepted', server_revision = ?3
                 WHERE id = ?1 AND outline_id = ?2
                   AND (server_revision IS NULL OR server_revision = ?3)",
                params![event_id, outline_id, revision],
            )?;
            highest = highest.max(*revision);
        }
        transaction.execute(
            "INSERT INTO outline_sync_state(outline_id, last_acked_revision)
             VALUES (?1, ?2)
             ON CONFLICT(outline_id) DO UPDATE SET
               last_acked_revision = MAX(last_acked_revision, excluded.last_acked_revision),
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![outline_id, highest],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn sync_state(&self, outline_id: &str) -> StoreResult<SyncState> {
        Ok(self
            .connection()?
            .query_row(
                "SELECT outline_id, last_acked_revision, last_pulled_revision, server_instance_id
             FROM outline_sync_state WHERE outline_id = ?1",
                [outline_id],
                |row| {
                    Ok(SyncState {
                        outline_id: row.get(0)?,
                        last_acked_revision: row.get(1)?,
                        last_pulled_revision: row.get(2)?,
                        server_instance_id: row.get(3)?,
                    })
                },
            )
            .optional()?
            .unwrap_or_else(|| SyncState {
                outline_id: outline_id.to_string(),
                ..SyncState::default()
            }))
    }

    pub fn record_pulled_revision(&self, outline_id: &str, revision: i64) -> StoreResult<()> {
        self.connection()?.execute(
            "INSERT INTO outline_sync_state(outline_id, last_pulled_revision)
             VALUES (?1, ?2)
             ON CONFLICT(outline_id) DO UPDATE SET
               last_pulled_revision = MAX(last_pulled_revision, excluded.last_pulled_revision),
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![outline_id, revision.max(0)],
        )?;
        Ok(())
    }

    pub fn save_checkpoint(&self, checkpoint: &CheckpointRecord) -> StoreResult<()> {
        self.connection()?.execute(
            "INSERT OR REPLACE INTO outline_checkpoints
             (id, outline_id, document_version, schema_epoch, local_sequence, server_revision,
              state_json, integrity_hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                checkpoint.id,
                checkpoint.outline_id,
                checkpoint.document_version,
                checkpoint.schema_epoch,
                checkpoint.local_sequence,
                checkpoint.server_revision,
                checkpoint.state_json,
                checkpoint.integrity_hash,
                checkpoint.created_at
            ],
        )?;
        Ok(())
    }

    pub fn latest_compatible_checkpoint(
        &self,
        outline_id: &str,
        document_version: i64,
        schema_epoch: i64,
    ) -> StoreResult<Option<CheckpointRecord>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, outline_id, document_version, schema_epoch, local_sequence,
                    server_revision, state_json, integrity_hash, created_at
             FROM outline_checkpoints
             WHERE outline_id = ?1 AND document_version = ?2 AND schema_epoch = ?3
             ORDER BY local_sequence DESC, julianday(created_at) DESC, created_at DESC",
        )?;
        let rows =
            statement.query_map(params![outline_id, document_version, schema_epoch], |row| {
                Ok(CheckpointRecord {
                    id: row.get(0)?,
                    outline_id: row.get(1)?,
                    document_version: row.get(2)?,
                    schema_epoch: row.get(3)?,
                    local_sequence: row.get(4)?,
                    server_revision: row.get(5)?,
                    state_json: row.get(6)?,
                    integrity_hash: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })?;
        let checkpoints = rows.collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let verified = checkpoints
            .into_iter()
            .filter(|checkpoint| {
                Self::checkpoint_hash(&checkpoint.state_json) == checkpoint.integrity_hash
            })
            .collect::<Vec<_>>();
        let Some(selected) = verified.first().cloned() else {
            return Ok(None);
        };
        if selected.local_sequence == 0 {
            return Ok(Some(selected));
        }

        // Older "Start Empty" builds wrote a valid replacement snapshot at
        // sequence zero even when an event log already existed. Recover one only
        // when its timestamp produces an unambiguous barrier and its document
        // exactly matches the next retained document event's before-hash.
        let newest_reset = verified
            .into_iter()
            .filter(|checkpoint| checkpoint.local_sequence == 0)
            .next();
        let Some(mut checkpoint) = newest_reset else {
            return Ok(Some(selected));
        };
        let Some(barrier) = Self::legacy_reset_barrier(&connection, &checkpoint, &selected)? else {
            return Ok(Some(selected));
        };
        checkpoint.local_sequence = barrier;
        Ok(Some(checkpoint))
    }

    fn legacy_reset_barrier(
        connection: &Connection,
        checkpoint: &CheckpointRecord,
        selected: &CheckpointRecord,
    ) -> StoreResult<Option<i64>> {
        let reset_is_later: Option<i64> = connection.query_row(
            "SELECT CASE
               WHEN julianday(?1) IS NULL OR julianday(?2) IS NULL THEN NULL
               ELSE julianday(?1) > julianday(?2)
             END",
            params![checkpoint.created_at, selected.created_at],
            |row| row.get(0),
        )?;
        if reset_is_later != Some(1) {
            return Ok(None);
        }

        let state: Value = match serde_json::from_str(&checkpoint.state_json) {
            Ok(state) => state,
            Err(_) => return Ok(None),
        };
        let empty_domain_state = state
            .get("trash")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
            && state
                .get("shortcuts")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty);
        let Some(document) = state.get("doc") else {
            return Ok(None);
        };
        if !empty_domain_state {
            return Ok(None);
        }

        let chronology_violations: i64 = connection.query_row(
            "WITH ordered AS (
               SELECT julianday(created_at) AS stamp,
                      LAG(julianday(created_at)) OVER (ORDER BY local_sequence) AS previous_stamp
               FROM outline_events WHERE outline_id = ?1
             )
             SELECT COUNT(*) FROM ordered
             WHERE stamp IS NULL OR (previous_stamp IS NOT NULL AND stamp < previous_stamp)",
            [checkpoint.outline_id.as_str()],
            |row| row.get(0),
        )?;
        if chronology_violations != 0 {
            return Ok(None);
        }

        let ambiguous_timestamp_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM outline_events
             WHERE outline_id = ?1 AND julianday(created_at) = julianday(?2)",
            params![checkpoint.outline_id, checkpoint.created_at],
            |row| row.get(0),
        )?;
        if ambiguous_timestamp_count != 0 {
            return Ok(None);
        }
        let barrier: i64 = connection.query_row(
            "SELECT COALESCE(MAX(local_sequence), 0) FROM outline_events
             WHERE outline_id = ?1 AND julianday(created_at) < julianday(?2)",
            params![checkpoint.outline_id, checkpoint.created_at],
            |row| row.get(0),
        )?;
        if barrier < selected.local_sequence {
            return Ok(None);
        }

        let next_envelope: Option<String> = connection
            .query_row(
                "SELECT envelope_json FROM outline_events
                 WHERE outline_id = ?1 AND local_sequence > ?2 AND superseded_by IS NULL
                 ORDER BY local_sequence LIMIT 1",
                params![checkpoint.outline_id, barrier],
                |row| row.get(0),
            )
            .optional()?;
        let Some(next_envelope) = next_envelope else {
            return Ok(None);
        };
        let next_event: Value = match serde_json::from_str(&next_envelope) {
            Ok(event) => event,
            Err(_) => return Ok(None),
        };
        let is_document_event = matches!(
            next_event.get("type").and_then(Value::as_str),
            Some("document.steps_applied" | "document.undo_applied" | "document.redo_applied")
        );
        let expected_before_hash = next_event
            .pointer("/payload/beforeHash")
            .and_then(Value::as_str);
        let document_hash = format!(
            "{:x}",
            Sha256::digest(Self::canonical_json(document).as_bytes())
        );
        if !is_document_event || expected_before_hash != Some(document_hash.as_str()) {
            return Ok(None);
        }
        Ok(Some(barrier))
    }

    fn canonical_json(value: &Value) -> String {
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
                serde_json::to_string(value).expect("JSON scalar serialization cannot fail")
            }
            Value::Array(values) => format!(
                "[{}]",
                values
                    .iter()
                    .map(Self::canonical_json)
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Value::Object(values) => {
                let mut entries = values.iter().collect::<Vec<_>>();
                entries.sort_by(|(left, _), (right, _)| left.cmp(right));
                format!(
                    "{{{}}}",
                    entries
                        .into_iter()
                        .map(|(key, child)| format!(
                            "{}:{}",
                            serde_json::to_string(key)
                                .expect("JSON object key serialization cannot fail"),
                            Self::canonical_json(child)
                        ))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
        }
    }

    pub fn checkpoint_hash(state_json: &str) -> String {
        format!("{:x}", Sha256::digest(state_json.as_bytes()))
    }

    pub fn storage_mode(&self) -> StoreResult<StorageMode> {
        let value: String = self.connection()?.query_row(
            "SELECT value FROM app_configuration WHERE key = 'storage_mode'",
            [],
            |row| row.get(0),
        )?;
        match value.as_str() {
            "local" => Ok(StorageMode::Local),
            "server" => Ok(StorageMode::Server),
            other => Err(StoreError::InvalidStorageMode(other.to_string())),
        }
    }

    pub fn set_storage_mode(&self, mode: StorageMode) -> StoreResult<()> {
        self.connection()?.execute(
            "INSERT INTO app_configuration(key, value) VALUES ('storage_mode', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [mode.as_str()],
        )?;
        Ok(())
    }

    pub fn get_or_create_identity(&self, key: &str, prefix: &str) -> StoreResult<String> {
        let generated = format!("{}_{}", prefix, uuid::Uuid::new_v4());
        let connection = self.connection()?;
        connection.execute(
            "INSERT OR IGNORE INTO app_configuration(key, value) VALUES (?1, ?2)",
            params![key, generated],
        )?;
        connection
            .query_row(
                "SELECT value FROM app_configuration WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
    }

    pub fn server_configuration(&self) -> StoreResult<Option<ServerConfiguration>> {
        let value = self
            .connection()?
            .query_row(
                "SELECT value FROM app_configuration WHERE key = 'server_configuration'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        value
            .map(|json| {
                serde_json::from_str(&json).map_err(|_| {
                    StoreError::InvalidStorageMode("invalid server configuration".into())
                })
            })
            .transpose()
    }

    pub fn set_server_configuration(&self, configuration: &ServerConfiguration) -> StoreResult<()> {
        let value = serde_json::to_string(configuration).expect("server configuration serializes");
        self.connection()?.execute(
            "INSERT INTO app_configuration(key, value) VALUES ('server_configuration', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [value],
        )?;
        Ok(())
    }

    pub fn clear_server_configuration(&self) -> StoreResult<()> {
        self.connection()?.execute(
            "DELETE FROM app_configuration WHERE key = 'server_configuration'",
            [],
        )?;
        Ok(())
    }
}

fn append_event(transaction: &Transaction<'_>, event: &EventRecord) -> StoreResult<()> {
    let envelope_json = serde_json::to_string(&event.envelope)
        .expect("serde_json::Value serialization cannot fail");
    let inserted = transaction.execute(
        "INSERT OR IGNORE INTO outline_events
         (id, outline_id, base_revision, server_revision, envelope_json, status, superseded_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![event.id, event.outline_id, event.base_revision, event.server_revision,
            envelope_json, event.status, event.superseded_by, event.created_at],
    )?;
    if inserted == 0 {
        let existing: String = transaction.query_row(
            "SELECT envelope_json FROM outline_events WHERE id = ?1",
            [&event.id],
            |row| row.get(0),
        )?;
        if existing != envelope_json {
            return Err(StoreError::EventIdConflict(event.id.clone()));
        }
    }
    Ok(())
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredEvent> {
    let envelope_json: String = row.get(5)?;
    let envelope = serde_json::from_str(&envelope_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            envelope_json.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(StoredEvent {
        local_sequence: row.get(0)?,
        record: EventRecord {
            id: row.get(1)?,
            outline_id: row.get(2)?,
            base_revision: row.get(3)?,
            server_revision: row.get(4)?,
            envelope,
            status: row.get(6)?,
            superseded_by: row.get(7)?,
            created_at: row.get(8)?,
        },
    })
}
