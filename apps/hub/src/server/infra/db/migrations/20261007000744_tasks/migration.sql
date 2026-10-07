CREATE TABLE `project_tasks` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`branch` text NOT NULL,
	`brief_path` text,
	`host_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_project_tasks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_members` (
	`task_id` text NOT NULL,
	`repo_name` text NOT NULL,
	`worktree_id` text,
	`role` text,
	`merge_order` integer DEFAULT 0 NOT NULL,
	`pr_number` integer,
	CONSTRAINT `task_members_pk` PRIMARY KEY(`task_id`, `repo_name`),
	CONSTRAINT `fk_task_members_task_id_project_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `project_tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `panel_states` ADD `task_id` text;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `task_id` text;--> statement-breakpoint
-- 6.3 task groups become tasks with members. The group id is kept, and a branch used by two groups of
-- one project gets a suffix on the later one, because a task's name is its folder name.
INSERT INTO `project_tasks`(`id`, `project_id`, `name`, `branch`, `brief_path`, `host_id`, `status`, `created_at`) SELECT g.`id`, g.`project_id`, CASE WHEN EXISTS (SELECT 1 FROM `task_groups` g2 WHERE g2.`project_id` = g.`project_id` AND replace(g2.`branch`, '/', '-') = replace(g.`branch`, '/', '-') AND g2.`rowid` < g.`rowid`) THEN replace(g.`branch`, '/', '-') || '-' || substr(g.`id`, 4, 6) ELSE replace(g.`branch`, '/', '-') END, g.`branch`, NULL, (SELECT m.`host_id` FROM `task_group_members` m WHERE m.`group_id` = g.`id` AND m.`host_id` IS NOT NULL ORDER BY m.`merge_order` LIMIT 1), 'active', g.`created_at` FROM `task_groups` g;--> statement-breakpoint
INSERT INTO `task_members`(`task_id`, `repo_name`, `worktree_id`, `role`, `merge_order`, `pr_number`) SELECT `group_id`, `repo`, `worktree_id`, NULL, `merge_order`, `pr_number` FROM `task_group_members`;--> statement-breakpoint
UPDATE `worktrees` SET `task_id` = (SELECT m.`group_id` FROM `task_group_members` m WHERE m.`worktree_id` = `worktrees`.`repo_name` || '-' || replace(`worktrees`.`name`, '/', '-') LIMIT 1);--> statement-breakpoint
-- Every other worktree that already has a project becomes a one-member task. Its folder stays where
-- it is. A worktree with no project gets its task at boot, once the default project exists.
UPDATE `worktrees` SET `task_id` = 'tsk-' || lower(hex(randomblob(6))) WHERE `task_id` IS NULL AND `project_id` IS NOT NULL;--> statement-breakpoint
INSERT INTO `project_tasks`(`id`, `project_id`, `name`, `branch`, `brief_path`, `host_id`, `status`, `created_at`) SELECT w.`task_id`, w.`project_id`, CASE WHEN EXISTS (SELECT 1 FROM `project_tasks` t WHERE t.`project_id` = w.`project_id` AND t.`name` = w.`repo_name` || '-' || replace(w.`name`, '/', '-')) THEN w.`repo_name` || '-' || replace(w.`name`, '/', '-') || '-' || substr(w.`task_id`, 5, 6) ELSE w.`repo_name` || '-' || replace(w.`name`, '/', '-') END, w.`name`, NULL, w.`host_id`, 'active', CAST(strftime('%s', 'now') AS integer) * 1000 FROM `worktrees` w WHERE w.`task_id` IS NOT NULL AND w.`task_id` NOT IN (SELECT `id` FROM `project_tasks`);--> statement-breakpoint
INSERT INTO `task_members`(`task_id`, `repo_name`, `worktree_id`, `role`, `merge_order`, `pr_number`) SELECT w.`task_id`, w.`repo_name`, w.`repo_name` || '-' || replace(w.`name`, '/', '-'), NULL, 0, NULL FROM `worktrees` w WHERE w.`task_id` IS NOT NULL AND w.`task_id` NOT IN (SELECT `task_id` FROM `task_members`);--> statement-breakpoint
-- A worktree's chats follow it into its task.
UPDATE `panel_states` SET `task_id` = (SELECT w.`task_id` FROM `worktrees` w WHERE w.`repo_name` || '-' || replace(w.`name`, '/', '-') = `panel_states`.`worktree_id` LIMIT 1) WHERE `panel_type` = 'chat' AND `worktree_id` IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `task_groups_project_idx`;--> statement-breakpoint
CREATE INDEX `project_tasks_project_idx` ON `project_tasks` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_tasks_project_name_idx` ON `project_tasks` (`project_id`,`name`);--> statement-breakpoint
DROP TABLE `task_group_members`;--> statement-breakpoint
DROP TABLE `task_groups`;