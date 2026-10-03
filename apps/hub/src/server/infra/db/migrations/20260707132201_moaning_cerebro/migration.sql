ALTER TABLE `cronjobs` ADD `via` text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE `cronjobs` ADD `last_terminal_id` text;