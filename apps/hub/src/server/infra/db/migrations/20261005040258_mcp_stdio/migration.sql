ALTER TABLE `mcp_servers` ADD `host_id` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `command` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `args` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `env` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `cwd` text;