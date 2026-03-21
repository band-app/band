CREATE TABLE `projects` (
	`name` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`default_branch` text NOT NULL,
	`label` text,
	`sort_order` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_name` text NOT NULL,
	`branch` text NOT NULL,
	`path` text NOT NULL,
	`head` text,
	FOREIGN KEY (`project_name`) REFERENCES `projects`(`name`) ON UPDATE no action ON DELETE cascade
);
