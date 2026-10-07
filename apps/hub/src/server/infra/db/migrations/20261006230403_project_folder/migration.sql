CREATE TABLE `legacy_coordinator_worktrees` (
	`worktree_id` text PRIMARY KEY,
	`project_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `legacy_coordinator_worktrees`(`worktree_id`, `project_id`) SELECT `coordinator_worktree_id`, `id` FROM `projects` WHERE `coordinator_worktree_id` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `panel_states` ADD `project_id` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_panel_states` (
	`id` text PRIMARY KEY,
	`worktree_id` text,
	`project_id` text,
	`panel_type` text NOT NULL,
	`state` text NOT NULL,
	`labels` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- A project's coordinator chat leaves its worktree and belongs to the project.
INSERT INTO `__new_panel_states`(`id`, `worktree_id`, `project_id`, `panel_type`, `state`, `labels`, `created_at`, `updated_at`) SELECT `id`, CASE WHEN `panel_type` = 'chat' AND EXISTS (SELECT 1 FROM `projects` p WHERE p.`coordinator_chat_id` = `panel_states`.`id`) THEN NULL ELSE `worktree_id` END, CASE WHEN `panel_type` = 'chat' THEN (SELECT p.`id` FROM `projects` p WHERE p.`coordinator_chat_id` = `panel_states`.`id`) ELSE NULL END, `panel_type`, `state`, `labels`, `created_at`, `updated_at` FROM `panel_states`;--> statement-breakpoint
DROP TABLE `panel_states`;--> statement-breakpoint
ALTER TABLE `__new_panel_states` RENAME TO `panel_states`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `coordinator_worktree_id`;