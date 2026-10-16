CREATE TABLE `chat_event_holds` (
	`id` integer NOT NULL,
	`host_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`row` text NOT NULL,
	`received_at` integer NOT NULL,
	CONSTRAINT `chat_event_holds_pk` PRIMARY KEY(`host_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `chat_forwards` (
	`id` text PRIMARY KEY,
	`chat_id` text NOT NULL,
	`host_id` text NOT NULL,
	`method` text NOT NULL,
	`params` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`reply` text
);
--> statement-breakpoint
CREATE INDEX `chat_event_holds_chat_idx` ON `chat_event_holds` (`chat_id`);--> statement-breakpoint
CREATE INDEX `chat_forwards_pending_idx` ON `chat_forwards` (`host_id`,`delivered_at`,`created_at`);