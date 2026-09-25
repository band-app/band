CREATE TABLE `chat_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`chat_id` text NOT NULL,
	`session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`update_kind` text,
	`message_id` text,
	`tool_call_id` text,
	`turn_start` integer DEFAULT false NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_events_session_idx` ON `chat_events` (`session_id`,`revision`,`id`);--> statement-breakpoint
CREATE INDEX `chat_events_kind_idx` ON `chat_events` (`session_id`,`revision`,`kind`,`id`);--> statement-breakpoint
CREATE INDEX `chat_events_update_kind_idx` ON `chat_events` (`session_id`,`revision`,`update_kind`,`id`);--> statement-breakpoint
CREATE INDEX `chat_events_chat_idx` ON `chat_events` (`chat_id`);