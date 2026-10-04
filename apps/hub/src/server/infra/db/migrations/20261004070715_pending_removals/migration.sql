CREATE TABLE `pending_removals` (
	`host_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`repo_path` text NOT NULL,
	`branch` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `pending_removals_pk` PRIMARY KEY(`host_id`, `worktree_path`),
	CONSTRAINT `fk_pending_removals_host_id_hosts_id_fk` FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON DELETE CASCADE
);
