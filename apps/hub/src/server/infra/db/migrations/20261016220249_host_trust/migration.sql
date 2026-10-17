CREATE TABLE `host_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`at` integer NOT NULL,
	`caller_host_id` text NOT NULL,
	`chat_id` text,
	`procedure` text NOT NULL,
	`target_host_id` text,
	`target` text
);
--> statement-breakpoint
ALTER TABLE `hosts` ADD `trust` text;--> statement-breakpoint
UPDATE `hosts` SET `trust` = 'standard';--> statement-breakpoint
CREATE INDEX `host_audit_at_idx` ON `host_audit` (`at`);
