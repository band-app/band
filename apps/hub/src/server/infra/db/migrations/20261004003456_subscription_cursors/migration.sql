CREATE TABLE `subscription_cursors` (
	`subscription_id` text PRIMARY KEY,
	`cursor` text NOT NULL,
	`updated_at` integer NOT NULL
);
