-- Who a schedule runs as (ADR-014): runs record the named app identity they ran as (null = the automation
-- identity), and schedules that run with their creator's own read access keep who granted it and whether it still
-- works here. The refresh token itself is sealed in token_cache under schedule:<schedule_id>.
CREATE TABLE "schedule_grants" (
	"schedule_id" uuid PRIMARY KEY NOT NULL,
	"user_oid" text NOT NULL,
	"upn" text NOT NULL,
	"home_account_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"consented_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone,
	CONSTRAINT "schedule_grants_status_check" CHECK ("schedule_grants"."status" in ('active', 'needs_sign_in'))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "identity_name" text;--> statement-breakpoint
ALTER TABLE "schedule_grants" ADD CONSTRAINT "schedule_grants_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;