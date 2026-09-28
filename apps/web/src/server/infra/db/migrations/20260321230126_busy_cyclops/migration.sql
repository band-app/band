CREATE TABLE `branch_statuses` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`git_dirty` integer NOT NULL,
	`git_conflict` integer NOT NULL,
	`git_ahead` integer NOT NULL,
	`git_behind` integer NOT NULL,
	`git_sync_state` text NOT NULL,
	`ci_state` text NOT NULL,
	`ci_url` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_statuses` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`branch` text NOT NULL,
	`worktree_path` text NOT NULL,
	`ide` text NOT NULL,
	`agent_name` text,
	`agent_status` text,
	`agent_last_activity` text,
	`agent_summary` text,
	`updated_at` integer NOT NULL
);
