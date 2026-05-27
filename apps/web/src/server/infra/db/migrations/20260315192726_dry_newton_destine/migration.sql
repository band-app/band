CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project` text NOT NULL,
	`branch` text NOT NULL,
	`prompt` text NOT NULL,
	`status` text NOT NULL,
	`session_id` text,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
