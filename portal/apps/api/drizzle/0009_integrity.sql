-- Referential integrity and status values (docs/operations.md → Postgres hardening). Each constraint is added NOT VALID
-- and then validated. Drizzle applies all pending migrations in one transaction, so the locks the ALTER TABLEs take are
-- held until it commits: on a large database, stop the api, worker and scheduler while migrating. Rows that would violate a
-- foreign key are first handled the way retention already treats them: steps and events of a run that no longer exists
-- are deleted (retention deletes them with their run), and links to a purged parent run, schedule or schedule run are
-- cleared (the same as ON DELETE SET NULL). A schedule run whose schedule is gone is not touched: validation then fails
-- and the migration stops, because that history should not exist (retention keeps a schedule while it has runs).
DELETE FROM "run_step_events" e WHERE NOT EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = e."run_id");--> statement-breakpoint
DELETE FROM "run_steps" s WHERE NOT EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = s."run_id");--> statement-breakpoint
UPDATE "runs" c SET "parent_run_id" = NULL WHERE "parent_run_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "runs" p WHERE p."id" = c."parent_run_id");--> statement-breakpoint
UPDATE "runs" r SET "schedule_id" = NULL WHERE "schedule_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "schedules" s WHERE s."id" = r."schedule_id");--> statement-breakpoint
UPDATE "schedule_runs" x SET "run_id" = NULL WHERE "run_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = x."run_id");--> statement-breakpoint
UPDATE "probe_results" p SET "schedule_run_id" = NULL WHERE "schedule_run_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "schedule_runs" x WHERE x."id" = p."schedule_run_id");--> statement-breakpoint
ALTER TABLE "probe_results" ADD CONSTRAINT "probe_results_schedule_run_id_schedule_runs_id_fk" FOREIGN KEY ("schedule_run_id") REFERENCES "public"."schedule_runs"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "run_step_events" ADD CONSTRAINT "run_step_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" in ('pending', 'approved', 'rejected', 'expired', 'cancelled')) NOT VALID;--> statement-breakpoint
ALTER TABLE "definitions" ADD CONSTRAINT "definitions_status_check" CHECK ("definitions"."status" in ('draft', 'in_review', 'published', 'retired')) NOT VALID;--> statement-breakpoint
ALTER TABLE "probe_results" ADD CONSTRAINT "probe_results_status_check" CHECK ("probe_results"."status" in ('ok', 'warn', 'crit', 'error')) NOT VALID;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_status_check" CHECK ("run_steps"."status" in ('running', 'waiting', 'succeeded', 'failed', 'skipped', 'planned', 'retried', 'cancelled', 'compensated', 'needs_review')) NOT VALID;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('queued', 'running', 'awaiting_approval', 'awaiting_input', 'awaiting_arm', 'awaiting_reauth', 'succeeded', 'failed', 'cancelled', 'compensated', 'needs_review')) NOT VALID;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_status_check" CHECK ("schedule_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'timeout', 'skipped')) NOT VALID;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_last_status_check" CHECK ("schedules"."last_status" in ('queued', 'running', 'succeeded', 'failed', 'timeout', 'skipped')) NOT VALID;--> statement-breakpoint
ALTER TABLE "probe_results" VALIDATE CONSTRAINT "probe_results_schedule_run_id_schedule_runs_id_fk";--> statement-breakpoint
ALTER TABLE "run_step_events" VALIDATE CONSTRAINT "run_step_events_run_id_runs_id_fk";--> statement-breakpoint
ALTER TABLE "run_steps" VALIDATE CONSTRAINT "run_steps_run_id_runs_id_fk";--> statement-breakpoint
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_schedule_id_schedules_id_fk";--> statement-breakpoint
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_parent_run_id_runs_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_runs" VALIDATE CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_runs" VALIDATE CONSTRAINT "schedule_runs_run_id_runs_id_fk";--> statement-breakpoint
ALTER TABLE "approvals" VALIDATE CONSTRAINT "approvals_status_check";--> statement-breakpoint
ALTER TABLE "definitions" VALIDATE CONSTRAINT "definitions_status_check";--> statement-breakpoint
ALTER TABLE "probe_results" VALIDATE CONSTRAINT "probe_results_status_check";--> statement-breakpoint
ALTER TABLE "run_steps" VALIDATE CONSTRAINT "run_steps_status_check";--> statement-breakpoint
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_status_check";--> statement-breakpoint
ALTER TABLE "schedule_runs" VALIDATE CONSTRAINT "schedule_runs_status_check";--> statement-breakpoint
ALTER TABLE "schedules" VALIDATE CONSTRAINT "schedules_last_status_check";
