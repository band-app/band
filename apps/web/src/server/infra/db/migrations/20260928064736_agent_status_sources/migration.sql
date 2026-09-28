CREATE TABLE `workspace_status_sources` (
	`workspace_id` text NOT NULL,
	`source_id` text NOT NULL,
	`status` text NOT NULL,
	`terminal_id` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `workspace_status_sources_pk` PRIMARY KEY(`workspace_id`, `source_id`)
);
--> statement-breakpoint
CREATE INDEX `workspace_status_sources_terminal_idx` ON `workspace_status_sources` (`terminal_id`);