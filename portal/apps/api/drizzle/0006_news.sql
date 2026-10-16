CREATE TABLE "news_feed_state" (
	"feed_key" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"status" text,
	"error_code" text,
	"error_message" text,
	"etag" text,
	"last_modified" text,
	"items" integer DEFAULT 0 NOT NULL,
	"new_items" integer DEFAULT 0 NOT NULL,
	"updated_items" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"definition_sha" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feed_key" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"url" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"areas" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text,
	"audience" text[] DEFAULT '{}'::text[] NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"activity_at" timestamp with time zone NOT NULL,
	"action_required_by" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "news_items_feed_external_uq" UNIQUE("feed_key","external_id")
);
--> statement-breakpoint
CREATE INDEX "news_items_activity_idx" ON "news_items" USING btree ("activity_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "news_items_feed_idx" ON "news_items" USING btree ("feed_key","activity_at");--> statement-breakpoint
CREATE INDEX "news_items_changed_idx" ON "news_items" USING btree ("changed_at");--> statement-breakpoint
CREATE INDEX "news_items_areas_idx" ON "news_items" USING gin ("areas");