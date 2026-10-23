ALTER TABLE `schedules` ADD `run_as` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `run_as_set_by` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `run_as_set_at` integer;--> statement-breakpoint
ALTER TABLE `schedules` ADD `approved_identity` text;