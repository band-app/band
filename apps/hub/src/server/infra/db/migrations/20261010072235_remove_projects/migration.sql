DELETE FROM `subscription_events` WHERE `subscription_id` IN (SELECT `id` FROM `subscriptions` WHERE `created_by` = 'coordinator' OR `source` = 'project' OR `worktree_id` LIKE 'project:%' OR `chat_id` IN (SELECT `id` FROM `panel_states` WHERE `worktree_id` IS NULL OR `project_id` IS NOT NULL OR `worktree_id` LIKE 'project:%'));--> statement-breakpoint
DELETE FROM `subscriptions` WHERE `created_by` = 'coordinator' OR `source` = 'project' OR `worktree_id` LIKE 'project:%' OR `chat_id` IN (SELECT `id` FROM `panel_states` WHERE `worktree_id` IS NULL OR `project_id` IS NOT NULL OR `worktree_id` LIKE 'project:%');--> statement-breakpoint
DELETE FROM `usage_events` WHERE `worktree_id` LIKE 'project:%';--> statement-breakpoint
DELETE FROM `agent_sessions` WHERE `worktree_id` LIKE 'project:%' OR `chat_id` IN (SELECT `id` FROM `panel_states` WHERE `worktree_id` IS NULL OR `project_id` IS NOT NULL OR `worktree_id` LIKE 'project:%');--> statement-breakpoint
DELETE FROM `tasks` WHERE `worktree_id` LIKE 'project:%';--> statement-breakpoint
DELETE FROM `chat_events` WHERE `chat_id` IN (SELECT `id` FROM `panel_states` WHERE `worktree_id` IS NULL OR `project_id` IS NOT NULL OR `worktree_id` LIKE 'project:%');--> statement-breakpoint
DELETE FROM `panel_states` WHERE `worktree_id` IS NULL OR `project_id` IS NOT NULL OR `worktree_id` LIKE 'project:%';--> statement-breakpoint
DELETE FROM `client_state` WHERE `worktree_id` LIKE 'project:%';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_worktrees` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`repo_name` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`branch` text NOT NULL,
	`path` text NOT NULL,
	`head` text,
	`pinned` integer DEFAULT false NOT NULL,
	`host_id` text DEFAULT 'local' NOT NULL,
	CONSTRAINT `fk_worktrees_repo_name_repos_name_fk` FOREIGN KEY (`repo_name`) REFERENCES `repos`(`name`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_worktrees`(`id`, `repo_name`, `name`, `branch`, `path`, `head`, `pinned`, `host_id`) SELECT `id`, `repo_name`, `name`, `branch`, `path`, `head`, `pinned`, `host_id` FROM `worktrees`;--> statement-breakpoint
DROP TABLE `worktrees`;--> statement-breakpoint
ALTER TABLE `__new_worktrees` RENAME TO `worktrees`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `context_events_at_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `contexts_name_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `dispatch_requests_project_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `project_tasks_project_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `project_tasks_project_name_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `projects_name_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `retro_proposals_project_idx`;--> statement-breakpoint
DROP TABLE `context_events`;--> statement-breakpoint
DROP TABLE `contexts`;--> statement-breakpoint
DROP TABLE `dispatch_requests`;--> statement-breakpoint
DROP TABLE `legacy_coordinator_worktrees`;--> statement-breakpoint
DROP TABLE `project_repos`;--> statement-breakpoint
DROP TABLE `project_tasks`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
DROP TABLE `retro_proposals`;--> statement-breakpoint
DROP TABLE `task_members`;--> statement-breakpoint
ALTER TABLE `panel_states` DROP COLUMN `project_id`;--> statement-breakpoint
ALTER TABLE `panel_states` DROP COLUMN `task_id`;