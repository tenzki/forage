CREATE TABLE IF NOT EXISTS owners (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outlines (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES owners(id),
  name text NOT NULL,
  current_revision bigint NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  api_inbox_id text NOT NULL,
  document_version integer NOT NULL DEFAULT 1,
  schema_epoch integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outline_events (
  id text PRIMARY KEY,
  outline_id text NOT NULL REFERENCES outlines(id),
  revision bigint NOT NULL CHECK (revision > 0),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  event_type text NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  document_version integer NOT NULL CHECK (document_version > 0),
  schema_epoch integer NOT NULL CHECK (schema_epoch > 0),
  actor_id text NOT NULL,
  device_id text NOT NULL,
  origin text NOT NULL,
  change_group_id text,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outline_id, revision)
);

CREATE OR REPLACE FUNCTION forage_reject_accepted_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'accepted outline events are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS outline_events_immutable_update ON outline_events;
CREATE TRIGGER outline_events_immutable_update BEFORE UPDATE ON outline_events
FOR EACH ROW EXECUTE FUNCTION forage_reject_accepted_event_mutation();
DROP TRIGGER IF EXISTS outline_events_immutable_delete ON outline_events;
CREATE TRIGGER outline_events_immutable_delete BEFORE DELETE ON outline_events
FOR EACH ROW EXECUTE FUNCTION forage_reject_accepted_event_mutation();

CREATE TABLE IF NOT EXISTS outline_checkpoints (
  id text PRIMARY KEY,
  outline_id text NOT NULL REFERENCES outlines(id),
  revision bigint NOT NULL CHECK (revision >= 0),
  document_version integer NOT NULL,
  schema_epoch integer NOT NULL,
  state jsonb NOT NULL,
  integrity_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outline_id, revision, schema_epoch)
);

CREATE TABLE IF NOT EXISTS outline_projections (
  outline_id text PRIMARY KEY REFERENCES outlines(id),
  revision bigint NOT NULL CHECK (revision >= 0),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS note_projections (
  outline_id text NOT NULL REFERENCES outlines(id),
  id text NOT NULL,
  parent_id text,
  text_content text NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (outline_id, id)
);

CREATE TABLE IF NOT EXISTS credentials (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES owners(id),
  outline_id text NOT NULL REFERENCES outlines(id),
  kind text NOT NULL CHECK (kind IN ('api', 'device')),
  name text NOT NULL,
  secret_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  credential_id text NOT NULL REFERENCES credentials(id),
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, key)
);

CREATE TABLE IF NOT EXISTS assets (
  asset_id text PRIMARY KEY CHECK (asset_id ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL REFERENCES owners(id),
  media_type text NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  storage_key text NOT NULL UNIQUE,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
