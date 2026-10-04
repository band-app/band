CREATE TABLE `environment_builds` (
	`id` text PRIMARY KEY,
	`project` text NOT NULL,
	`key` text NOT NULL,
	`status` text NOT NULL,
	`image` text,
	`host_id` text NOT NULL,
	`commit_sha` text,
	`trigger` text NOT NULL,
	`log` text DEFAULT '' NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `environment_builds_project_idx` ON `environment_builds` (`project`,`started_at`);--> statement-breakpoint
CREATE INDEX `environment_builds_key_idx` ON `environment_builds` (`project`,`key`);