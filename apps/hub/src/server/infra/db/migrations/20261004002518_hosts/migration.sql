CREATE TABLE `hosts` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`mode` text DEFAULT 'attached' NOT NULL,
	`runner` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'online' NOT NULL,
	`last_seen_at` integer,
	`info` text,
	`version` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `hosts` (`id`, `name`, `mode`, `status`, `created_at`) VALUES ('local', 'Local', 'attached', 'online', CAST(strftime('%s', 'now') AS integer) * 1000);
--> statement-breakpoint
CREATE TABLE `project_hosts` (
	`project_name` text NOT NULL,
	`host_id` text NOT NULL,
	`path` text NOT NULL,
	CONSTRAINT `project_hosts_pk` PRIMARY KEY(`project_name`, `host_id`),
	CONSTRAINT `fk_project_hosts_project_name_projects_name_fk` FOREIGN KEY (`project_name`) REFERENCES `projects`(`name`) ON DELETE CASCADE,
	CONSTRAINT `fk_project_hosts_host_id_hosts_id_fk` FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `cronjobs` ADD `host_id` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `host_id` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_scan_state` ADD `host_id` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_statuses` ADD `host_id` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `host_id` text DEFAULT 'local' NOT NULL;
--> statement-breakpoint
INSERT INTO `project_hosts` (`project_name`, `host_id`, `path`) SELECT `name`, 'local', `path` FROM `projects`;
