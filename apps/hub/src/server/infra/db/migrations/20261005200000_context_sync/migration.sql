CREATE TABLE `context_events` (
	`id` text PRIMARY KEY,
	`context` text NOT NULL,
	`host_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `contexts` ADD `repos` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `context_events_at_idx` ON `context_events` (`at`);
--> statement-breakpoint
UPDATE `contexts` SET `kind` = 'project' WHERE `kind` = 'mission';
