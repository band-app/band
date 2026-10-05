CREATE TABLE `mcp_proxy_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`at` integer NOT NULL,
	`server` text NOT NULL,
	`tool` text NOT NULL,
	`session_id` text NOT NULL,
	`ok` integer NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `mcp_proxy_tokens` (
	`id` text PRIMARY KEY,
	`hash` text NOT NULL,
	`session_id` text NOT NULL,
	`servers` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`transport` text DEFAULT 'http' NOT NULL,
	`vault_item_id` text,
	`header_name` text DEFAULT 'Authorization' NOT NULL,
	`header_prefix` text DEFAULT 'Bearer ' NOT NULL,
	`allow_tools` text,
	`read_only` integer DEFAULT false NOT NULL,
	`read_only_tools` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mcp_proxy_audit_at_idx` ON `mcp_proxy_audit` (`at`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_proxy_tokens_hash_idx` ON `mcp_proxy_tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `mcp_proxy_tokens_session_idx` ON `mcp_proxy_tokens` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_idx` ON `mcp_servers` (`name`);