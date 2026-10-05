CREATE TABLE `project_repos` (
	`project_id` text NOT NULL,
	`repo_name` text NOT NULL,
	`role` text,
	CONSTRAINT `project_repos_pk` PRIMARY KEY(`project_id`, `repo_name`),
	CONSTRAINT `fk_project_repos_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`context_name` text NOT NULL,
	`coordinator_agent` text,
	`coordinator_model` text DEFAULT 'opus' NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`policy` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `worktrees` ADD `project_id` text REFERENCES projects(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_idx` ON `projects` (`name`);--> statement-breakpoint
UPDATE `contexts` SET `kind` = 'project' WHERE `kind` = 'mission';
