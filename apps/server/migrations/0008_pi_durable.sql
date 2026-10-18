-- Execution checkpoints belong to the call, independently of its outline result.
-- The origin run ties retention to the existing whole-call history lifecycle.
CREATE TABLE IF NOT EXISTS agent_durable_calls (
  outline_id text NOT NULL REFERENCES outlines(id),
  call_id text NOT NULL,
  origin_run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  owner_nonce text NOT NULL,
  next_id bigint NOT NULL DEFAULT 2,
  sequence bigint NOT NULL DEFAULT 0,
  journal_bytes bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outline_id, call_id)
);
CREATE TABLE IF NOT EXISTS agent_durable_commits (
  outline_id text NOT NULL,
  call_id text NOT NULL,
  sequence bigint NOT NULL,
  writes jsonb NOT NULL CHECK (jsonb_typeof(writes) = 'array'),
  PRIMARY KEY (outline_id, call_id, sequence),
  FOREIGN KEY (outline_id, call_id) REFERENCES agent_durable_calls(outline_id, call_id) ON DELETE CASCADE
);
