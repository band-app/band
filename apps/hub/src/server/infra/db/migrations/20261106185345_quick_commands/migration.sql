CREATE TABLE `quick_commands` (
	`id` text PRIMARY KEY,
	`label` text NOT NULL,
	`repo_name` text,
	`action` text NOT NULL,
	`command` text DEFAULT '' NOT NULL,
	`append_enter` integer DEFAULT true NOT NULL,
	`agent_id` text,
	`prompt` text DEFAULT '' NOT NULL,
	`last_run_at` integer,
	`created_at` integer NOT NULL
);
