ALTER TABLE `repos` ADD `meta` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `origin_worktree_id` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `origin_chat_id` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `origin_terminal_id` text;