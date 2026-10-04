CREATE TABLE `workspace_sleep` (
	`workspace_id` text PRIMARY KEY,
	`host_id` text NOT NULL,
	`project` text NOT NULL,
	`name` text NOT NULL,
	`branch` text NOT NULL,
	`worktree_path` text NOT NULL,
	`base_sha` text NOT NULL,
	`snapshot_sha` text NOT NULL,
	`ref` text NOT NULL,
	`store` text NOT NULL,
	`session_ids` text DEFAULT '[]' NOT NULL,
	`waking_since` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workspace_sleep_host_idx` ON `workspace_sleep` (`host_id`);