CREATE TABLE `tokens` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`hash` text NOT NULL,
	`host_id` text,
	`label` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	CONSTRAINT `fk_tokens_host_id_hosts_id_fk` FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_hash_idx` ON `tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `tokens_host_idx` ON `tokens` (`host_id`);
