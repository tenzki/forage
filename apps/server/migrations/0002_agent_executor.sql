ALTER TABLE outline_events ADD COLUMN IF NOT EXISTS agent_provenance jsonb;

CREATE TABLE IF NOT EXISTS agent_configuration_revisions (
  outline_id text NOT NULL REFERENCES outlines(id),
  revision bigint NOT NULL CHECK (revision > 0),
  configuration jsonb NOT NULL,
  published_by text NOT NULL REFERENCES credentials(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outline_id, revision)
);

CREATE TABLE IF NOT EXISTS agent_automation_revisions (
  outline_id text NOT NULL REFERENCES outlines(id),
  revision bigint NOT NULL CHECK (revision > 0),
  policies jsonb NOT NULL,
  published_by text NOT NULL REFERENCES credentials(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outline_id, revision)
);

CREATE TABLE IF NOT EXISTS agent_provider_credentials (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES owners(id),
  outline_id text NOT NULL REFERENCES outlines(id),
  provider text NOT NULL CHECK (provider IN ('openai-codex', 'openai', 'supadata', 'image-provider')),
  status text NOT NULL CHECK (status IN ('pending', 'connected', 'authentication_required', 'disconnected')),
  ciphertext bytea,
  nonce bytea,
  key_version integer,
  account_label text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((ciphertext IS NULL AND nonce IS NULL AND key_version IS NULL)
      OR (ciphertext IS NOT NULL AND nonce IS NOT NULL AND key_version IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES owners(id),
  outline_id text NOT NULL REFERENCES outlines(id),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('manual', 'inbox_automation')),
  trigger_identity text NOT NULL,
  idempotency_key text,
  source_note_id text,
  target_note_id text NOT NULL,
  input_snapshot jsonb NOT NULL,
  definition_snapshot jsonb NOT NULL,
  configuration_revision bigint NOT NULL,
  credential_reference text NOT NULL REFERENCES agent_provider_credentials(id),
  status text NOT NULL CHECK (status IN (
    'queued', 'running', 'retry_wait', 'completed', 'failed', 'cancelled', 'interrupted'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  error_code text,
  retry_of_run_id text REFERENCES agent_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outline_id, trigger_identity, configuration_revision)
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_claim
  ON agent_runs(available_at, created_at)
  WHERE status IN ('queued', 'retry_wait');
CREATE INDEX IF NOT EXISTS idx_agent_runs_outline_history
  ON agent_runs(outline_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS agent_run_attempts (
  run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'lease_lost')),
  error_code text,
  PRIMARY KEY (run_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS agent_run_results (
  run_id text PRIMARY KEY REFERENCES agent_runs(id),
  result_identity text NOT NULL UNIQUE,
  first_revision bigint NOT NULL CHECK (first_revision > 0),
  last_revision bigint NOT NULL CHECK (last_revision >= first_revision),
  root_note_ids text[] NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now()
);
