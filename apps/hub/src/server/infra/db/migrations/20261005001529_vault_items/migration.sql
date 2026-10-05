CREATE TABLE `vault_items` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`encrypted` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_items_scope_name_idx` ON `vault_items` (`scope`,`name`);