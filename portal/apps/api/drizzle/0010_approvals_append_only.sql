-- Approval decisions are append-only (docs/operations.md → Postgres hardening), enforced in the database whatever the
-- application does: a new approval starts pending with no decisions; only the decision part of a row can change; a
-- recorded decision never changes (the one exception is `sessionHash`, rebound when the same person resumes a run with
-- a new session — runs/service.ts); and once an approval is decided (approved, rejected, expired, cancelled) it is
-- final. Deleting decided approvals stays possible (retention purges them with their run). This stops history being
-- rewritten — turning a rejection into an approval, or changing who approved; it can't stop a compromised service from
-- recording a forged decision, which the hash-chained audit log (with its external checkpoints) records alongside.
CREATE OR REPLACE FUNCTION approvals_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR jsonb_array_length(NEW.decisions) <> 0 OR NEW.decided_at IS NOT NULL THEN
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
  IF jsonb_array_length(NEW.decisions) < jsonb_array_length(OLD.decisions) THEN
    RAISE EXCEPTION 'approvals: decisions are append-only';
  END IF;
  FOR i IN 0 .. jsonb_array_length(OLD.decisions) - 1 LOOP
    IF ((NEW.decisions -> i) - 'sessionHash') IS DISTINCT FROM ((OLD.decisions -> i) - 'sessionHash') THEN
      RAISE EXCEPTION 'approvals: a recorded decision cannot change';
    END IF;
  END LOOP;
  IF OLD.status <> 'pending' AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR jsonb_array_length(NEW.decisions) <> jsonb_array_length(OLD.decisions)) THEN
    RAISE EXCEPTION 'approvals: a decided approval is final (%)', OLD.status;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approvals_append_only BEFORE INSERT OR UPDATE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION approvals_append_only();
