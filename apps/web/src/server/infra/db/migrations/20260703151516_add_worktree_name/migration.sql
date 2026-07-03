ALTER TABLE `worktrees` ADD `name` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `worktrees` SET `name` = `branch`;