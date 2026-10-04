CREATE TABLE `tokens` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`hash` text NOT NULL,
	`host_id` text,
	`label` text DEFAULT '' NOT NULL,
	`admin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	CONSTRAINT `fk_tokens_host_id_hosts_id_fk` FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_hash_idx` ON `tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `tokens_host_idx` ON `tokens` (`host_id`);--> statement-breakpoint
CREATE INDEX `tokens_created_at_idx` ON `tokens` (`created_at`);--> statement-breakpoint
CREATE INDEX `hosts_created_at_idx` ON `hosts` (`created_at`);
