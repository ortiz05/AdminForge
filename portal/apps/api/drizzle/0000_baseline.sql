CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`step_id` text,
	`policy` text NOT NULL,
	`decisions` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	CONSTRAINT "approvals_status_check" CHECK("approvals"."status" in ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
	CONSTRAINT "approvals_decisions_array" CHECK(json_type("approvals"."decisions") = 'array')
);
--> statement-breakpoint
CREATE INDEX `approvals_subject_idx` ON `approvals` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`actor_oid` text,
	`actor_upn` text,
	`session_hash` text,
	`mode` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`details` text,
	`result` text NOT NULL,
	`correlation_id` text NOT NULL,
	`ip` text,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_actor_idx` ON `audit_events` (`actor_oid`);--> statement-breakpoint
CREATE INDEX `audit_action_idx` ON `audit_events` (`action`);--> statement-breakpoint
CREATE INDEX `audit_ts_idx` ON `audit_events` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_correlation_idx` ON `audit_events` (`correlation_id`);--> statement-breakpoint
CREATE TABLE `definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`version` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`body` text NOT NULL,
	`sha256` text NOT NULL,
	`author_oid` text,
	`approver_oid` text,
	`created_at` integer NOT NULL,
	`published_at` integer,
	CONSTRAINT "definitions_status_check" CHECK("definitions"."status" in ('draft', 'in_review', 'published', 'retired'))
);
--> statement-breakpoint
CREATE INDEX `definitions_lookup_idx` ON `definitions` (`kind`,`key`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `definitions_kind_key_version` ON `definitions` (`kind`,`key`,`version`);--> statement-breakpoint
CREATE TABLE `leases` (
	`name` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `news_feed_state` (
	`feed_key` text PRIMARY KEY NOT NULL,
	`last_run_at` integer,
	`last_success_at` integer,
	`status` text,
	`error_code` text,
	`error_message` text,
	`etag` text,
	`last_modified` text,
	`items` integer DEFAULT 0 NOT NULL,
	`new_items` integer DEFAULT 0 NOT NULL,
	`updated_items` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`definition_sha` text,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `news_items` (
	`id` text PRIMARY KEY NOT NULL,
	`feed_key` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`url` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`areas` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`status` text,
	`audience` text DEFAULT '[]' NOT NULL,
	`published_at` integer NOT NULL,
	`updated_at` integer,
	`activity_at` integer NOT NULL,
	`action_required_by` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`changed_at` integer NOT NULL,
	`content_hash` text NOT NULL,
	`facts` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `news_items_activity_idx` ON `news_items` (`activity_at`,`id`);--> statement-breakpoint
CREATE INDEX `news_items_feed_idx` ON `news_items` (`feed_key`,`activity_at`);--> statement-breakpoint
CREATE INDEX `news_items_changed_idx` ON `news_items` (`changed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `news_items_feed_external_uq` ON `news_items` (`feed_key`,`external_id`);--> statement-breakpoint
CREATE TABLE `preauth` (
	`state` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`return_to` text NOT NULL,
	`session_id_hash` text,
	`binding_hash` text,
	`details` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `preauth_expires_idx` ON `preauth` (`expires_at`);--> statement-breakpoint
CREATE TABLE `probe_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`probe_key` text NOT NULL,
	`ts` integer NOT NULL,
	`status` text NOT NULL,
	`metric` real,
	`duration_ms` integer,
	`message` text,
	`details` text,
	`schedule_run_id` text,
	FOREIGN KEY (`schedule_run_id`) REFERENCES `schedule_runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "probe_results_status_check" CHECK("probe_results"."status" in ('ok', 'warn', 'crit', 'error'))
);
--> statement-breakpoint
CREATE INDEX `probe_results_probe_ts_idx` ON `probe_results` (`probe_key`,`ts`);--> statement-breakpoint
CREATE INDEX `probe_results_schedule_run_idx` ON `probe_results` (`schedule_run_id`);--> statement-breakpoint
CREATE TABLE `run_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`state` text NOT NULL,
	`start_after` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_holder` text,
	`lease_until` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "run_jobs_state_check" CHECK("run_jobs"."state" in ('queued', 'active'))
);
--> statement-breakpoint
CREATE INDEX `run_jobs_due_idx` ON `run_jobs` (`state`,`start_after`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_jobs_run_state_uq` ON `run_jobs` (`run_id`,`state`);--> statement-breakpoint
CREATE TABLE `run_step_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`step_seq` integer,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`level` text,
	`data` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_step_events_run_idx` ON `run_step_events` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `run_steps` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`step_id` text NOT NULL,
	`path` text NOT NULL,
	`type` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`actor_oid` text,
	`mode` text NOT NULL,
	`request` text,
	`plan` text,
	`output` text,
	`error` text,
	`ms_request_id` text,
	`started_at` integer,
	`ended_at` integer,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "run_steps_status_check" CHECK("run_steps"."status" in ('running', 'waiting', 'succeeded', 'failed', 'skipped', 'planned', 'retried', 'cancelled', 'compensated', 'needs_review'))
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`definition_key` text NOT NULL,
	`definition_version` text NOT NULL,
	`definition_sha256` text NOT NULL,
	`status` text NOT NULL,
	`dry_run` integer DEFAULT false NOT NULL,
	`trigger` text DEFAULT 'interactive' NOT NULL,
	`identity` text DEFAULT 'delegated' NOT NULL,
	`identity_name` text,
	`initiator_oid` text,
	`initiator_upn` text,
	`session_hash` text,
	`schedule_id` text,
	`parent_run_id` text,
	`inputs` text DEFAULT '{}' NOT NULL,
	`outputs` text,
	`error` text,
	`correlation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "runs_status_check" CHECK("runs"."status" in ('queued', 'running', 'awaiting_approval', 'awaiting_input', 'awaiting_arm', 'awaiting_reauth', 'succeeded', 'failed', 'cancelled', 'compensated', 'needs_review'))
);
--> statement-breakpoint
CREATE INDEX `runs_initiator_idx` ON `runs` (`initiator_oid`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX `runs_definition_idx` ON `runs` (`definition_key`);--> statement-breakpoint
CREATE INDEX `runs_parent_idx` ON `runs` (`parent_run_id`);--> statement-breakpoint
CREATE INDEX `runs_created_idx` ON `runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `runs_schedule_idx` ON `runs` (`schedule_id`);--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`user_oid` text NOT NULL,
	`page_key` text NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `saved_views_page_idx` ON `saved_views` (`page_key`,`user_oid`);--> statement-breakpoint
CREATE TABLE `schedule_grants` (
	`schedule_id` text PRIMARY KEY NOT NULL,
	`user_oid` text NOT NULL,
	`upn` text NOT NULL,
	`home_account_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`consented_at` integer NOT NULL,
	`checked_at` integer,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "schedule_grants_status_check" CHECK("schedule_grants"."status" in ('active', 'needs_sign_in'))
);
--> statement-breakpoint
CREATE TABLE `schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`schedule_key` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`result` text,
	`error` text,
	`artifact_path` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "schedule_runs_status_check" CHECK("schedule_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'timeout', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `schedule_runs_schedule_idx` ON `schedule_runs` (`schedule_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `schedule_runs_run_idx` ON `schedule_runs` (`run_id`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`source` text NOT NULL,
	`definition` text NOT NULL,
	`sha256` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_by` text,
	`approved_by` text,
	`approved_target` text,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_status` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "schedules_last_status_check" CHECK("schedules"."last_status" in ('queued', 'running', 'succeeded', 'failed', 'timeout', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedules_key_unique` ON `schedules` (`key`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_oid` text NOT NULL,
	`upn` text NOT NULL,
	`display_name` text NOT NULL,
	`tenant_id` text NOT NULL,
	`tenant_name` text NOT NULL,
	`tenant_domain` text NOT NULL,
	`roles` text DEFAULT '[]' NOT NULL,
	`csrf` text NOT NULL,
	`read_account_id` text,
	`write_account_id` text,
	`write_expires_at` integer,
	`write_extended` integer DEFAULT false NOT NULL,
	`write_reason` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`roles_checked_at` integer
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_oid`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`payload` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `signals_created_idx` ON `signals` (`created_at`);--> statement-breakpoint
CREATE TABLE `token_cache` (
	`partition_key` text PRIMARY KEY NOT NULL,
	`sealed` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_prefs` (
	`user_oid` text PRIMARY KEY NOT NULL,
	`prefs` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
