CREATE TABLE `usage_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`task_id` text NOT NULL,
	`chat_id` text,
	`workspace_id` text NOT NULL,
	`project` text NOT NULL,
	`session_id` text,
	`coding_agent_id` text,
	`provider` text,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_events_captured_at_idx` ON `usage_events` (`captured_at`);--> statement-breakpoint
CREATE INDEX `usage_events_task_idx` ON `usage_events` (`task_id`);--> statement-breakpoint
CREATE INDEX `usage_events_workspace_idx` ON `usage_events` (`workspace_id`);