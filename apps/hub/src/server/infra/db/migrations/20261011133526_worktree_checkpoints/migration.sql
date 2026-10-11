CREATE TABLE `worktree_checkpoints` (
	`id` text PRIMARY KEY,
	`worktree_id` text NOT NULL,
	`host_id` text NOT NULL,
	`repo` text NOT NULL,
	`name` text NOT NULL,
	`branch` text NOT NULL,
	`base_sha` text NOT NULL,
	`snapshot_sha` text NOT NULL,
	`tree_sha` text NOT NULL,
	`has_bundle` integer NOT NULL,
	`session_ids` text DEFAULT '[]' NOT NULL,
	`sessions_hash` text DEFAULT '' NOT NULL,
	`size_bytes` integer NOT NULL,
	`trigger` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `repos` ADD `checkpoints_enabled` integer;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `superseded_by` text;--> statement-breakpoint
CREATE INDEX `worktree_checkpoints_worktree_idx` ON `worktree_checkpoints` (`worktree_id`,`created_at`);