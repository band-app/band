ALTER TABLE `agent_sessions` ADD `status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `status_updated_at` integer DEFAULT 0 NOT NULL;