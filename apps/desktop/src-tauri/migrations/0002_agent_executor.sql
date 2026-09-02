PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS local_agent_runs (
    id TEXT PRIMARY KEY NOT NULL,
    outline_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'retry_wait', 'completed', 'failed', 'cancelled', 'interrupted'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    result_identity TEXT UNIQUE,
    result_json TEXT,
    retry_of_run_id TEXT REFERENCES local_agent_runs(id),
    cancel_requested_at TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((result_identity IS NULL) = (result_json IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_local_agent_runs_outline_status
    ON local_agent_runs(outline_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS local_agent_run_attempts (
    run_id TEXT NOT NULL REFERENCES local_agent_runs(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_code TEXT,
    PRIMARY KEY (run_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS local_agent_run_activity (
    run_id TEXT NOT NULL REFERENCES local_agent_runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence)
);
