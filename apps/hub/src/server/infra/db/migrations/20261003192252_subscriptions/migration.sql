CREATE TABLE `subscription_events` (
	`event_id` text PRIMARY KEY,
	`subscription_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`delivered_at` integer,
	`summary` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY,
	`chat_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`source` text NOT NULL,
	`kinds` text NOT NULL,
	`filter_key` text NOT NULL,
	`coalesce_seconds` integer NOT NULL,
	`max_wakeups` integer NOT NULL,
	`wakeups` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subscription_events_subscription_idx` ON `subscription_events` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_chat_idx` ON `subscriptions` (`chat_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_workspace_idx` ON `subscriptions` (`workspace_id`);