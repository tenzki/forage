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
             ORDER BY local_sequence DESC",
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
        for checkpoint in rows {
            let checkpoint = checkpoint?;
            if Self::checkpoint_hash(&checkpoint.state_json) == checkpoint.integrity_hash {
                return Ok(Some(checkpoint));
            }
        }
        Ok(None)
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
