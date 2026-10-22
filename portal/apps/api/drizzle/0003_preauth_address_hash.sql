ALTER TABLE `preauth` ADD `address_hash` text;--> statement-breakpoint
CREATE INDEX `preauth_address_idx` ON `preauth` (`address_hash`);