ALTER TABLE `repos` ADD `auto_continue` integer;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `continued_from` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `divergence` text;