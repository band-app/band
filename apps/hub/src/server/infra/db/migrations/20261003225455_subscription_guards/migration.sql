CREATE TABLE `pushed_shas` (
	`sha` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`pushed_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `subscription_events` ADD `dropped_reason` text;