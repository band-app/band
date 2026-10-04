CREATE TABLE `host_requests` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`project` text NOT NULL,
	`branch` text NOT NULL,
	`labels` text DEFAULT '{}' NOT NULL,
	`requires` text DEFAULT '{}' NOT NULL,
	`environment` text,
	`input` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`leased_by` text,
	`lease_expires_at` integer,
	`host_id` text,
	`error` text,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `host_requests_status_idx` ON `host_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `host_requests_workspace_idx` ON `host_requests` (`workspace_id`);