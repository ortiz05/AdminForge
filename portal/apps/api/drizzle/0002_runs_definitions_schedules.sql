CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"step_id" text,
	"policy" jsonb NOT NULL,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"body" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"author_oid" text,
	"approver_oid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "definitions_kind_key_version" UNIQUE("kind","key","version")
);
--> statement-breakpoint
CREATE TABLE "probe_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"probe_key" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"metric" double precision,
	"duration_ms" integer,
	"message" text,
	"details" jsonb,
	"schedule_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "run_step_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"step_seq" integer,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"level" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"step_id" text NOT NULL,
	"path" text NOT NULL,
	"type" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"actor_oid" text,
	"mode" text NOT NULL,
	"request" jsonb,
	"plan" jsonb,
	"output" jsonb,
	"error" jsonb,
	"ms_request_id" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "run_steps_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"definition_key" text NOT NULL,
	"definition_version" text NOT NULL,
	"definition_sha256" text NOT NULL,
	"status" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"trigger" text DEFAULT 'interactive' NOT NULL,
	"identity" text DEFAULT 'delegated' NOT NULL,
	"initiator_oid" text,
	"initiator_upn" text,
	"session_hash" text,
	"schedule_id" uuid,
	"parent_run_id" uuid,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outputs" jsonb,
	"error" jsonb,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_oid" text NOT NULL,
	"page_key" text NOT NULL,
	"name" text NOT NULL,
	"state" jsonb NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"schedule_key" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"run_id" uuid,
	"result" jsonb,
	"error" jsonb,
	"artifact_path" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"source" text NOT NULL,
	"definition" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"approved_by" text,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE INDEX "approvals_subject_idx" ON "approvals" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "definitions_lookup_idx" ON "definitions" USING btree ("kind","key","status");--> statement-breakpoint
CREATE INDEX "probe_results_probe_ts_idx" ON "probe_results" USING btree ("probe_key","ts");--> statement-breakpoint
CREATE INDEX "run_step_events_run_idx" ON "run_step_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "runs_initiator_idx" ON "runs" USING btree ("initiator_oid","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_definition_idx" ON "runs" USING btree ("definition_key");--> statement-breakpoint
CREATE INDEX "saved_views_page_idx" ON "saved_views" USING btree ("page_key","user_oid");--> statement-breakpoint
CREATE INDEX "schedule_runs_schedule_idx" ON "schedule_runs" USING btree ("schedule_id","started_at");