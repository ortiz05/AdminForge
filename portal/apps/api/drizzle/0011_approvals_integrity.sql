-- Approvals, continued (docs/operations.md → Postgres hardening; 0010 made decisions append-only):
--   1. Trigger functions run with a fixed search_path (pg_catalog first, pg_temp last) and name every table by schema,
--      so nobody who can create objects in a schema on the caller's path (the services' role owns `pgboss`) can shadow
--      an operator or function the checks rely on.
--   2. A decision can be rebound only to a session of the person who made it (the same person resuming a run with a
--      new session — runs/service.ts); any other change to a recorded decision is refused, as before.
--   3. An approval is deleted only together with its run or schedule (checked when the transaction commits, so
--      retention's "approvals, then the run" order works): deleting a decided approval and inserting a fresh one for
--      the same run can't turn a rejection into an approval.
CREATE OR REPLACE FUNCTION public.approvals_append_only() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  i integer;
  rebound text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR pg_catalog.jsonb_array_length(NEW.decisions) <> 0 OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'approvals: a new approval starts pending, with no decisions';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.step_id IS DISTINCT FROM OLD.step_id
     OR NEW.policy IS DISTINCT FROM OLD.policy
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'approvals: only the decision of an approval can change';
  END IF;
  IF pg_catalog.jsonb_array_length(NEW.decisions) < pg_catalog.jsonb_array_length(OLD.decisions) THEN
    RAISE EXCEPTION 'approvals: decisions are append-only';
  END IF;
  FOR i IN 0 .. pg_catalog.jsonb_array_length(OLD.decisions) - 1 LOOP
    IF ((NEW.decisions -> i) - 'sessionHash') IS DISTINCT FROM ((OLD.decisions -> i) - 'sessionHash') THEN
      RAISE EXCEPTION 'approvals: a recorded decision cannot change';
    END IF;
    rebound := (NEW.decisions -> i) ->> 'sessionHash';
    IF rebound IS DISTINCT FROM ((OLD.decisions -> i) ->> 'sessionHash')
       AND NOT EXISTS (
         SELECT 1 FROM public.sessions s
          WHERE s.id_hash = rebound AND s.user_oid = ((NEW.decisions -> i) ->> 'oid')) THEN
      RAISE EXCEPTION 'approvals: a decision can be rebound only to a session of the person who made it';
    END IF;
  END LOOP;
  IF OLD.status <> 'pending' AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR pg_catalog.jsonb_array_length(NEW.decisions) <> pg_catalog.jsonb_array_length(OLD.decisions)) THEN
    RAISE EXCEPTION 'approvals: a decided approval is final (%)', OLD.status;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.audit_events_append_only() SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.approvals_delete_with_subject() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.subject_id ~ '^[0-9a-fA-F-]{36}$' AND (
       (OLD.subject_type = 'run' AND EXISTS (SELECT 1 FROM public.runs r WHERE r.id = OLD.subject_id::uuid))
       OR (OLD.subject_type = 'schedule' AND EXISTS (SELECT 1 FROM public.schedules s WHERE s.id = OLD.subject_id::uuid))) THEN
    RAISE EXCEPTION 'approvals: an approval is deleted only together with its % (retention)', OLD.subject_type;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER approvals_delete_with_subject AFTER DELETE ON public.approvals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.approvals_delete_with_subject();
