-- Append-only history, enforced in the database whatever the application does (ADR-016; docs/operations.md →
-- Database). SQLite has no roles: these triggers stop the application (a bug, a bad migration, a careless query) from
-- rewriting history, not someone with write access to the volume — the hash-chained audit log and its checkpoints in
-- the container log are what detect that. `adminforge db import-postgres` recreates these triggers from this file after
-- copying history in: keep each trigger a single statement between breakpoints.
--
-- Audit events: no UPDATE, no DELETE (SQLite has no TRUNCATE; `DELETE FROM` fires the row trigger).
CREATE TRIGGER `audit_events_no_update` BEFORE UPDATE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only (UPDATE blocked)');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_events_no_delete` BEFORE DELETE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only (DELETE blocked)');
END;
--> statement-breakpoint
-- Approval decisions: a new approval starts pending with no decisions; only the decision part of a row can change; a
-- recorded decision never changes (except `sessionHash`, rebound only to a session of the same person when they resume
-- a run with a new session — runs/service.ts); a decided approval (approved, rejected, expired, cancelled) is final;
-- and an approval is deleted only once its run or schedule is gone (retention deletes the run first). This stops
-- history being rewritten — turning a rejection into an approval, or changing who approved. Each rule is one trigger,
-- guarded so that exactly one of them answers a given change.
CREATE TRIGGER `approvals_insert_pending` BEFORE INSERT ON `approvals`
WHEN NEW.`status` <> 'pending' OR json_array_length(NEW.`decisions`) <> 0 OR NEW.`decided_at` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approvals: a new approval starts pending, with no decisions');
END;
--> statement-breakpoint
CREATE TRIGGER `approvals_fixed_fields` BEFORE UPDATE ON `approvals`
WHEN NEW.`id` IS NOT OLD.`id`
  OR NEW.`subject_type` IS NOT OLD.`subject_type`
  OR NEW.`subject_id` IS NOT OLD.`subject_id`
  OR NEW.`step_id` IS NOT OLD.`step_id`
  OR NEW.`policy` IS NOT OLD.`policy`
  OR NEW.`requested_by` IS NOT OLD.`requested_by`
  OR NEW.`expires_at` IS NOT OLD.`expires_at`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'approvals: only the decision of an approval can change');
END;
--> statement-breakpoint
CREATE TRIGGER `approvals_decisions_append_only` BEFORE UPDATE OF `decisions` ON `approvals`
WHEN json_array_length(NEW.`decisions`) < json_array_length(OLD.`decisions`)
BEGIN
  SELECT RAISE(ABORT, 'approvals: decisions are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `approvals_decisions_unchanged` BEFORE UPDATE OF `decisions` ON `approvals`
WHEN json_array_length(NEW.`decisions`) >= json_array_length(OLD.`decisions`) AND EXISTS (
  SELECT 1 FROM json_each(OLD.`decisions`) AS o
   WHERE json_remove(o.value, '$.sessionHash')
         IS NOT json_remove(json_extract(NEW.`decisions`, '$[' || o.key || ']'), '$.sessionHash')
)
BEGIN
  SELECT RAISE(ABORT, 'approvals: a recorded decision cannot change');
END;
--> statement-breakpoint
CREATE TRIGGER `approvals_rebind_own_session` BEFORE UPDATE OF `decisions` ON `approvals`
WHEN json_array_length(NEW.`decisions`) >= json_array_length(OLD.`decisions`) AND EXISTS (
  SELECT 1 FROM json_each(OLD.`decisions`) AS o
   WHERE json_remove(o.value, '$.sessionHash')
         IS json_remove(json_extract(NEW.`decisions`, '$[' || o.key || ']'), '$.sessionHash')
     AND json_extract(NEW.`decisions`, '$[' || o.key || '].sessionHash') IS NOT json_extract(o.value, '$.sessionHash')
     AND NOT EXISTS (
       SELECT 1 FROM `sessions` AS s
        WHERE s.`id_hash` = json_extract(NEW.`decisions`, '$[' || o.key || '].sessionHash')
          AND s.`user_oid` = json_extract(NEW.`decisions`, '$[' || o.key || '].oid'))
)
BEGIN
  SELECT RAISE(ABORT, 'approvals: a decision can be rebound only to a session of the person who made it');
END;
--> statement-breakpoint
CREATE TRIGGER `approvals_decided_final` BEFORE UPDATE ON `approvals`
WHEN OLD.`status` <> 'pending' AND (
     NEW.`status` IS NOT OLD.`status`
  OR NEW.`decided_at` IS NOT OLD.`decided_at`
  OR json_array_length(NEW.`decisions`) <> json_array_length(OLD.`decisions`))
BEGIN
  SELECT RAISE(ABORT, 'approvals: a decided approval is final');
END;
--> statement-breakpoint
CREATE TRIGGER `approvals_delete_with_subject` BEFORE DELETE ON `approvals`
WHEN (OLD.`subject_type` = 'run' AND EXISTS (SELECT 1 FROM `runs` AS r WHERE r.`id` = OLD.`subject_id`))
  OR (OLD.`subject_type` = 'schedule' AND EXISTS (SELECT 1 FROM `schedules` AS s WHERE s.`id` = OLD.`subject_id`))
BEGIN
  SELECT RAISE(ABORT, 'approvals: an approval is deleted only together with its run or schedule (retention)');
END;
