CREATE TABLE `worktree_groups` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `worktrees` ADD `group_id` text;--> statement-breakpoint
-- A repo's label id becomes the group id of its worktrees. The groups themselves are created at
-- boot from the labels in settings.json (same ids), which also clears ids that name no label.
UPDATE `worktrees` SET `group_id` = (SELECT `label` FROM `repos` WHERE `repos`.`name` = `worktrees`.`repo_name`) WHERE `repo_name` IN (SELECT `name` FROM `repos` WHERE `label` IS NOT NULL AND `label` != '');--> statement-breakpoint
ALTER TABLE `repos` DROP COLUMN `label`;--> statement-breakpoint
UPDATE `client_state` SET `key` = CASE `key`
  WHEN 'band.repos-list.collapsed-labels' THEN 'band.repos-list.collapsed-groups'
  WHEN 'band.repos-list.label-filter' THEN 'band.repos-list.group-filter'
  WHEN 'band.repos-list.label-last-worktree' THEN 'band.repos-list.group-last-worktree'
  WHEN 'band.mobile.label-filter' THEN 'band.mobile.group-filter'
  ELSE `key` END;
