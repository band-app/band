CREATE TABLE `worktree_pr_overrides` (
	`worktree_id` text PRIMARY KEY,
	`url` text NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`set_by` text NOT NULL,
	`set_at` integer NOT NULL
);