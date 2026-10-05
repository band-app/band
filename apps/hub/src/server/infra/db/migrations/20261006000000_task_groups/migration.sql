CREATE TABLE `dispatch_requests` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`input` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`result` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	CONSTRAINT `fk_dispatch_requests_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_group_members` (
	`group_id` text NOT NULL,
	`repo` text NOT NULL,
	`worktree_id` text,
	`host_id` text,
	`pr_number` integer,
	`merge_order` integer NOT NULL,
	CONSTRAINT `task_group_members_pk` PRIMARY KEY(`group_id`, `repo`),
	CONSTRAINT `fk_task_group_members_group_id_task_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `task_groups`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_groups` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`brief` text NOT NULL,
	`branch` text NOT NULL,
	`mode` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_task_groups_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `dispatch_requests_project_idx` ON `dispatch_requests` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `task_groups_project_idx` ON `task_groups` (`project_id`);