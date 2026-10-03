CREATE TABLE `cronjobs` (
	`id` text PRIMARY KEY NOT NULL,
	`file_key` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`cron_expression` text NOT NULL,
	`scope` text NOT NULL,
	`workspace_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`last_run_at` text,
	`last_run_status` text
);
