ALTER TABLE `tokens` ADD `device_id` text;--> statement-breakpoint
ALTER TABLE `tokens` ADD `sealed` text;--> statement-breakpoint
CREATE INDEX `tokens_device_idx` ON `tokens` (`device_id`);