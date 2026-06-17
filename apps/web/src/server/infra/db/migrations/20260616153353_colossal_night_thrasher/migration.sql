ALTER TABLE `worktrees` ADD `workspace_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `worktrees` SET `workspace_id` = `project_name` || '-' || REPLACE(`branch`, '/', '-');--> statement-breakpoint
-- The derived id encoding is non-injective: project `foo-bar`+branch `main`
-- and project `foo`+branch `bar/main` both backfill to `foo-bar-main`. A
-- pre-existing DB holding such a colliding pair would make the UNIQUE INDEX
-- below fail and abort the migration on boot. Disambiguate every duplicate
-- (all rows in a colliding group except the lowest-`id` keeper) by appending
-- the row's unique `id`, so the keeper retains the historical derived value
-- (existing chats/tasks keyed on it stay valid) and the index can't throw.
UPDATE `worktrees` SET `workspace_id` = `workspace_id` || '-' || `id`
  WHERE `id` NOT IN (SELECT MIN(`id`) FROM `worktrees` GROUP BY `workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_workspace_id_unique` ON `worktrees` (`workspace_id`);
