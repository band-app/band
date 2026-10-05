CREATE TABLE `host_machines` (
	`host_id` text PRIMARY KEY,
	`runner_id` text NOT NULL,
	`machine_handle` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runner_snapshots` (
	`id` text PRIMARY KEY,
	`runner_id` text NOT NULL,
	`host_id` text NOT NULL,
	`workspace_ids` text DEFAULT '[]' NOT NULL,
	`snapshot_id` text NOT NULL,
	`size_bytes` integer,
	`restored_at` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runner_snapshots_host_idx` ON `runner_snapshots` (`host_id`);--> statement-breakpoint
CREATE INDEX `runner_snapshots_runner_idx` ON `runner_snapshots` (`runner_id`,`created_at`);