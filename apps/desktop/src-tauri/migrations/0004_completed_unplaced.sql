PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

BEGIN IMMEDIATE;

ALTER TABLE local_agent_runs RENAME TO local_agent_runs_before_completed_unplaced;

CREATE TABLE local_agent_runs (
    id TEXT PRIMARY KEY NOT NULL,
    outline_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'retry_wait', 'completed', 'completed_unplaced', 'failed', 'cancelled', 'interrupted'
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

INSERT INTO local_agent_runs
    (id, outline_id, snapshot_json, status, attempt_count, result_identity, result_json,
     retry_of_run_id, cancel_requested_at, error_code, created_at, updated_at)
SELECT id, outline_id, snapshot_json, status, attempt_count, result_identity, result_json,
       retry_of_run_id, cancel_requested_at, error_code, created_at, updated_at
FROM local_agent_runs_before_completed_unplaced;

DROP TABLE local_agent_runs_before_completed_unplaced;

CREATE INDEX IF NOT EXISTS idx_local_agent_runs_outline_status
    ON local_agent_runs(outline_id, status, created_at DESC);

COMMIT;

PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
