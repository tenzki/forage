-- Server call conversations: a manual skill run starts a call, and replies resume
-- its agent transcript. Each settled turn stores the Pi session entries it appended,
-- written in the same transaction that records the run's outcome, so a retried or
-- lease-recovered attempt never stores a turn twice or partially.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS call_id text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS call_turn integer;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_call_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_call_check CHECK (
  (call_id IS NULL AND call_turn IS NULL) OR (call_id IS NOT NULL AND call_turn > 0)
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_call
  ON agent_runs(outline_id, call_id) WHERE call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_call_turns (
  call_id text NOT NULL,
  turn integer NOT NULL CHECK (turn > 0),
  run_id text NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES owners(id),
  outline_id text NOT NULL REFERENCES outlines(id),
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array'),
  entry_bytes integer NOT NULL CHECK (entry_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, turn)
);
CREATE INDEX IF NOT EXISTS idx_agent_call_turns_age ON agent_call_turns(created_at);

-- An answer is kept beside structured output but is never placed in the outline.
ALTER TABLE agent_run_outputs ADD COLUMN IF NOT EXISTS output_kind text NOT NULL DEFAULT 'structured';
ALTER TABLE agent_run_outputs DROP CONSTRAINT IF EXISTS agent_run_outputs_output_kind_check;
ALTER TABLE agent_run_outputs ADD CONSTRAINT agent_run_outputs_output_kind_check CHECK (
  output_kind = 'structured' OR (output_kind = 'answer' AND placed_at IS NULL)
);

-- Clearing finished history deletes whole runs; their results go with them and
-- retries of a deleted run lose only the back reference.
ALTER TABLE agent_run_results DROP CONSTRAINT IF EXISTS agent_run_results_run_id_fkey;
ALTER TABLE agent_run_results ADD CONSTRAINT agent_run_results_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_retry_of_run_id_fkey;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_retry_of_run_id_fkey
  FOREIGN KEY (retry_of_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;
