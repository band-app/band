CREATE TABLE `host_provisions` (
	`id` text PRIMARY KEY,
	`code_hash` text NOT NULL,
	`run_hash` text,
	`hub_url` text NOT NULL,
	`host_name` text NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`repo_url` text,
	`branch` text,
	`command` text,
	`commit_sha` text,
	`host_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`exit_code` integer,
	`log` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`spent_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_provisions_code_idx` ON `host_provisions` (`code_hash`);--> statement-breakpoint
CREATE INDEX `host_provisions_created_idx` ON `host_provisions` (`created_at`);