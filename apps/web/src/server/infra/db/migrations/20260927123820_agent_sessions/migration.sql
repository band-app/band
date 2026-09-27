CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`agent_definition_id` text NOT NULL,
	`provider_session_id` text,
	`mode` text NOT NULL,
	`chat_id` text,
	`terminal_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_sessions_workspace_idx` ON `agent_sessions` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `agent_sessions_chat_idx` ON `agent_sessions` (`chat_id`);--> statement-breakpoint
CREATE INDEX `agent_sessions_terminal_idx` ON `agent_sessions` (`terminal_id`);