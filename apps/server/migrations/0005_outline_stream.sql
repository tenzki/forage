-- Live change notification for connected desktop clients.
--
-- Notification happens in the database rather than in application code because
-- the agent worker runs in its own process: an in-process emitter in the API
-- would never observe a commit made by the worker. Payloads stay small because
-- NOTIFY caps them at 8000 bytes; subscribers read the events themselves.

CREATE OR REPLACE FUNCTION notify_outline_changed() RETURNS trigger AS $$
BEGIN
  IF NEW.current_revision IS DISTINCT FROM OLD.current_revision THEN
    PERFORM pg_notify('forage_outline_changed', json_build_object(
      'outlineId', NEW.id,
      'revision', NEW.current_revision
    )::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_outline_changed ON outlines;
CREATE TRIGGER trg_notify_outline_changed
  AFTER UPDATE ON outlines
  FOR EACH ROW EXECUTE FUNCTION notify_outline_changed();

CREATE OR REPLACE FUNCTION notify_agent_activity() RETURNS trigger AS $$
DECLARE
  run agent_runs%ROWTYPE;
BEGIN
  SELECT * INTO run FROM agent_runs WHERE id = NEW.run_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify('forage_agent_activity', json_build_object(
    'outlineId', run.outline_id,
    'runId', NEW.run_id,
    'activitySeq', NEW.sequence,
    'status', run.status
  )::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_agent_activity ON agent_run_events;
CREATE TRIGGER trg_notify_agent_activity
  AFTER INSERT ON agent_run_events
  FOR EACH ROW EXECUTE FUNCTION notify_agent_activity();

CREATE OR REPLACE FUNCTION notify_agent_run_status() RETURNS trigger AS $$
DECLARE
  latest bigint;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(max(sequence), 0) INTO latest FROM agent_run_events WHERE run_id = NEW.id;
  PERFORM pg_notify('forage_agent_activity', json_build_object(
    'outlineId', NEW.outline_id,
    'runId', NEW.id,
    'activitySeq', latest,
    'status', NEW.status
  )::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_agent_run_status ON agent_runs;
CREATE TRIGGER trg_notify_agent_run_status
  AFTER UPDATE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION notify_agent_run_status();
