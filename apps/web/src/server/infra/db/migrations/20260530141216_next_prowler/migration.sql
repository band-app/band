CREATE TABLE `usage_scan_state` (
	`workspace_id` text NOT NULL,
	`agent_type` text NOT NULL,
	`last_scanned_updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `usage_events` ADD `external_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_external_key_uq` ON `usage_events` (`external_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_scan_state_pk` ON `usage_scan_state` (`workspace_id`,`agent_type`);