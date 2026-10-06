ALTER TABLE `projects` ADD `is_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `remote_url` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `remote_key` text;