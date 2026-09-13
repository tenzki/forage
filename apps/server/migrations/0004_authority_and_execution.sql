CREATE TABLE IF NOT EXISTS note_projection_status (
  outline_id text PRIMARY KEY REFERENCES outlines(id),
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  rebuild_status text NOT NULL CHECK (rebuild_status IN ('ready', 'rebuilding', 'failed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_compute_profiles (
  outline_id text PRIMARY KEY REFERENCES outlines(id),
  revision bigint NOT NULL CHECK (revision > 0),
  provider text NOT NULL CHECK (provider IN ('openai-codex', 'openai')),
  model_id text NOT NULL,
  credential_reference text NOT NULL REFERENCES agent_provider_credentials(id),
  updated_by text NOT NULL REFERENCES credentials(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Preserve the environment binding from the latest version-1 configuration
-- before removing it from portable definitions. This is an idempotent upcast;
-- environments without a complete binding remain explicitly compute-not-ready.
WITH latest AS (
  SELECT DISTINCT ON (configuration_revision.outline_id)
    configuration_revision.outline_id,
    configuration_revision.published_by,
    configuration_revision.configuration
  FROM agent_configuration_revisions configuration_revision
  ORDER BY configuration_revision.outline_id, configuration_revision.revision DESC
), binding AS (
  SELECT DISTINCT ON (latest.outline_id) latest.outline_id, latest.published_by,
    agent->>'modelId' AS model_id, agent->>'credentialRef' AS credential_reference
  FROM latest
  CROSS JOIN LATERAL jsonb_array_elements(latest.configuration->'agents') agent
  WHERE latest.configuration->>'version' = '1'
    AND COALESCE(agent->>'modelId', '') <> ''
    AND COALESCE(agent->>'credentialRef', '') <> ''
  ORDER BY latest.outline_id
)
INSERT INTO agent_compute_profiles(outline_id,revision,provider,model_id,credential_reference,updated_by)
SELECT binding.outline_id,1,credential.provider,binding.model_id,binding.credential_reference,binding.published_by
FROM binding
JOIN agent_provider_credentials credential
  ON credential.id=binding.credential_reference AND credential.outline_id=binding.outline_id
ON CONFLICT (outline_id) DO NOTHING;

WITH portable AS (
  SELECT configuration_revision.outline_id, configuration_revision.revision,
    jsonb_set(
      jsonb_set(configuration_revision.configuration, '{version}', '2'::jsonb),
      '{agents}',
      COALESCE((SELECT jsonb_agg(agent - 'modelId' - 'credentialRef')
        FROM jsonb_array_elements(configuration_revision.configuration->'agents') agent), '[]'::jsonb)
    ) AS configuration
  FROM agent_configuration_revisions configuration_revision
  WHERE configuration_revision.configuration->>'version' = '1'
)
UPDATE agent_configuration_revisions configuration_revision
SET configuration=portable.configuration
FROM portable
WHERE configuration_revision.outline_id=portable.outline_id
  AND configuration_revision.revision=portable.revision;

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS invocation_id text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS intent_hash text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS acknowledged_outline_revision bigint;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS resolved_compute jsonb;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS placement_error text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_invocation
  ON agent_runs(outline_id, invocation_id) WHERE invocation_id IS NOT NULL;

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_outline_id_trigger_identity_configuration_revision_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_trigger_identity
  ON agent_runs(outline_id, trigger_identity);

CREATE TABLE IF NOT EXISTS agent_run_outputs (
  run_id text PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  result_identity text NOT NULL UNIQUE,
  structured_output jsonb NOT NULL,
  persisted_at timestamptz NOT NULL DEFAULT now(),
  placed_at timestamptz,
  target_note_id text,
  CHECK ((placed_at IS NULL) OR (target_note_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS provisioning_steps (
  credential_id text NOT NULL REFERENCES credentials(id),
  outline_id text NOT NULL REFERENCES outlines(id),
  step text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, outline_id, step)
);

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check CHECK (status IN (
  'queued', 'running', 'retry_wait', 'completed', 'completed_unplaced', 'failed', 'cancelled', 'interrupted'
));
