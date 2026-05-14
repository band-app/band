CREATE TABLE `browser_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`workspace_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`favicon_url` text,
	`last_visited_at` integer NOT NULL,
	`visit_count` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_history_workspace_url_uq` ON `browser_history` (`workspace_id`,`url`);--> statement-breakpoint
CREATE INDEX `browser_history_workspace_visited_idx` ON `browser_history` (`workspace_id`,`last_visited_at`);