ALTER TABLE outlines ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ready';

ALTER TABLE outlines DROP CONSTRAINT IF EXISTS outlines_state_check;
ALTER TABLE outlines ADD CONSTRAINT outlines_state_check CHECK (state IN ('seeding', 'ready'));

ALTER TABLE outlines ALTER COLUMN api_inbox_id DROP NOT NULL;

ALTER TABLE outlines DROP CONSTRAINT IF EXISTS outlines_ready_has_inbox;
ALTER TABLE outlines ADD CONSTRAINT outlines_ready_has_inbox
  CHECK (state <> 'ready' OR api_inbox_id IS NOT NULL);

ALTER TABLE credentials ALTER COLUMN outline_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS outlines_one_per_owner ON outlines(owner_id);
