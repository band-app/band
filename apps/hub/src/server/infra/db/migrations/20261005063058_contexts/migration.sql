CREATE TABLE `contexts` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`remote_url` text,
	`remote_vault_item_id` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`worker_access` text DEFAULT 'read-write' NOT NULL,
	`sync_error` text,
	`last_sync_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contexts_name_idx` ON `contexts` (`name`);