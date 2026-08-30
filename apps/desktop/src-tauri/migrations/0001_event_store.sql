PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS outline_events (
    local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    outline_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
    server_revision INTEGER CHECK (server_revision IS NULL OR server_revision > 0),
    envelope_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    superseded_by TEXT,
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outline_events_server_revision
    ON outline_events(outline_id, server_revision)
    WHERE server_revision IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outline_events_outbox
    ON outline_events(outline_id, status, local_sequence)
    WHERE status = 'pending' AND superseded_by IS NULL;

CREATE TABLE IF NOT EXISTS outline_checkpoints (
    id TEXT PRIMARY KEY NOT NULL,
    outline_id TEXT NOT NULL,
    document_version INTEGER NOT NULL CHECK (document_version > 0),
    schema_epoch INTEGER NOT NULL CHECK (schema_epoch > 0),
    local_sequence INTEGER NOT NULL CHECK (local_sequence >= 0),
    server_revision INTEGER NOT NULL CHECK (server_revision >= 0),
    state_json TEXT NOT NULL,
    integrity_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outline_checkpoints_compatible
    ON outline_checkpoints(outline_id, document_version, schema_epoch, local_sequence DESC);

CREATE TABLE IF NOT EXISTS outline_sync_state (
    outline_id TEXT PRIMARY KEY NOT NULL,
    last_acked_revision INTEGER NOT NULL DEFAULT 0 CHECK (last_acked_revision >= 0),
    last_pulled_revision INTEGER NOT NULL DEFAULT 0 CHECK (last_pulled_revision >= 0),
    server_instance_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS app_configuration (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO app_configuration(key, value) VALUES ('storage_mode', 'local');

CREATE TABLE IF NOT EXISTS asset_cache (
    asset_id TEXT PRIMARY KEY NOT NULL,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    local_path TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    server_available INTEGER NOT NULL DEFAULT 0 CHECK (server_available IN (0, 1))
);
