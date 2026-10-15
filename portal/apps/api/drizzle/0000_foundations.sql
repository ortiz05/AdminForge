CREATE TABLE "audit_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"actor_oid" text,
	"actor_upn" text,
	"session_hash" text,
	"mode" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"details" jsonb,
	"result" text NOT NULL,
	"correlation_id" text NOT NULL,
	"ip" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preauth" (
	"state" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"return_to" text NOT NULL,
	"session_id_hash" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_oid" text NOT NULL,
	"upn" text NOT NULL,
	"display_name" text NOT NULL,
	"tenant_id" text NOT NULL,
	"tenant_name" text NOT NULL,
	"tenant_domain" text NOT NULL,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"csrf" text NOT NULL,
	"read_account_id" text,
	"write_account_id" text,
	"write_expires_at" timestamp with time zone,
	"write_extended" boolean DEFAULT false NOT NULL,
	"write_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_cache" (
	"partition_key" text PRIMARY KEY NOT NULL,
	"sealed" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_prefs" (
	"user_oid" text PRIMARY KEY NOT NULL,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_events" USING btree ("actor_oid");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_ts_idx" ON "audit_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "preauth_expires_idx" ON "preauth" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_oid");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");