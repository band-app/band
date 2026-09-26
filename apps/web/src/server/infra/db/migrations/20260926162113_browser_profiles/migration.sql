CREATE TABLE `browser_profiles` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`source` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_browser_profiles` (
	`project_name` text PRIMARY KEY,
	`profile_id` text NOT NULL,
	`updated_at` integer NOT NULL
);
