ALTER TABLE `projects` RENAME TO `repos`;--> statement-breakpoint
ALTER TABLE `project_hosts` RENAME TO `repo_hosts`;--> statement-breakpoint
ALTER TABLE `project_browser_profiles` RENAME TO `repo_browser_profiles`;--> statement-breakpoint
ALTER TABLE `workspace_statuses` RENAME TO `worktree_statuses`;--> statement-breakpoint
ALTER TABLE `workspace_status_sources` RENAME TO `worktree_status_sources`;--> statement-breakpoint
ALTER TABLE `workspace_sleep` RENAME TO `worktree_sleep`;--> statement-breakpoint
ALTER TABLE `repo_hosts` RENAME COLUMN `project_name` TO `repo_name`;--> statement-breakpoint
ALTER TABLE `repo_browser_profiles` RENAME COLUMN `project_name` TO `repo_name`;--> statement-breakpoint
ALTER TABLE `worktrees` RENAME COLUMN `project_name` TO `repo_name`;--> statement-breakpoint
ALTER TABLE `worktree_statuses` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `worktree_statuses` RENAME COLUMN `project` TO `repo`;--> statement-breakpoint
ALTER TABLE `worktree_status_sources` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `worktree_sleep` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `worktree_sleep` RENAME COLUMN `project` TO `repo`;--> statement-breakpoint
ALTER TABLE `branch_statuses` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `host_requests` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `host_requests` RENAME COLUMN `project` TO `repo`;--> statement-breakpoint
ALTER TABLE `environment_builds` RENAME COLUMN `project` TO `repo`;--> statement-breakpoint
ALTER TABLE `runner_snapshots` RENAME COLUMN `workspace_ids` TO `worktree_ids`;--> statement-breakpoint
ALTER TABLE `tasks` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `tasks` RENAME COLUMN `project` TO `repo`;--> statement-breakpoint
ALTER TABLE `panel_states` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `cronjobs` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `usage_events` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `usage_events` RENAME COLUMN `project` TO `repo`;--> statement-breakpoint
ALTER TABLE `usage_scan_state` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `browser_history` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `agent_sessions` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `client_state` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `subscriptions` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `pushed_shas` RENAME COLUMN `workspace_id` TO `worktree_id`;--> statement-breakpoint
ALTER TABLE `mcp_servers` RENAME COLUMN `scope_projects` TO `scope_repos`;--> statement-breakpoint
DROP INDEX `workspace_status_sources_terminal_idx`;--> statement-breakpoint
CREATE INDEX `worktree_status_sources_terminal_idx` ON `worktree_status_sources` (`terminal_id`);--> statement-breakpoint
DROP INDEX `host_requests_workspace_idx`;--> statement-breakpoint
CREATE INDEX `host_requests_worktree_idx` ON `host_requests` (`worktree_id`);--> statement-breakpoint
DROP INDEX `environment_builds_project_idx`;--> statement-breakpoint
CREATE INDEX `environment_builds_repo_idx` ON `environment_builds` (`repo`,`started_at`);--> statement-breakpoint
DROP INDEX `workspace_sleep_host_idx`;--> statement-breakpoint
CREATE INDEX `worktree_sleep_host_idx` ON `worktree_sleep` (`host_id`);--> statement-breakpoint
DROP INDEX `usage_events_workspace_idx`;--> statement-breakpoint
CREATE INDEX `usage_events_worktree_idx` ON `usage_events` (`worktree_id`);--> statement-breakpoint
DROP INDEX `browser_history_workspace_url_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `browser_history_worktree_url_uq` ON `browser_history` (`worktree_id`,`url`);--> statement-breakpoint
DROP INDEX `browser_history_workspace_visited_idx`;--> statement-breakpoint
CREATE INDEX `browser_history_worktree_visited_idx` ON `browser_history` (`worktree_id`,`last_visited_at`);--> statement-breakpoint
DROP INDEX `agent_sessions_workspace_idx`;--> statement-breakpoint
CREATE INDEX `agent_sessions_worktree_idx` ON `agent_sessions` (`worktree_id`);--> statement-breakpoint
DROP INDEX `client_state_workspace_idx`;--> statement-breakpoint
CREATE INDEX `client_state_worktree_idx` ON `client_state` (`worktree_id`);--> statement-breakpoint
DROP INDEX `subscriptions_workspace_idx`;--> statement-breakpoint
CREATE INDEX `subscriptions_worktree_idx` ON `subscriptions` (`worktree_id`);--> statement-breakpoint
UPDATE `cronjobs` SET `scope` = CASE `scope` WHEN 'project' THEN 'repo' WHEN 'workspace' THEN 'worktree' ELSE `scope` END;--> statement-breakpoint
UPDATE `vault_items` SET `scope` = 'repo:' || substr(`scope`, 9) WHERE `scope` LIKE 'project:%';--> statement-breakpoint
UPDATE `client_state` SET `key` = CASE `key`
  WHEN 'band-recent-workspaces' THEN 'band-recent-worktrees'
  WHEN 'band.projects-list.collapsed-projects' THEN 'band.repos-list.collapsed-repos'
  WHEN 'band.projects-list.collapsed-labels' THEN 'band.repos-list.collapsed-labels'
  WHEN 'band.projects-list.collapsed-pinned' THEN 'band.repos-list.collapsed-pinned'
  WHEN 'band.projects-list.label-filter' THEN 'band.repos-list.label-filter'
  WHEN 'band.projects-list.label-last-workspace' THEN 'band.repos-list.label-last-worktree'
  WHEN 'band:last-workspace' THEN 'band:last-worktree'
  ELSE `key` END;--> statement-breakpoint
UPDATE `host_requests` SET `input` = replace(replace(replace(replace(replace(`input`, '"project":', '"repo":'), '"hostProjectPath":', '"hostRepoPath":'), '"workspaceIds":', '"worktreeIds":'), '"workspaceId":', '"worktreeId":'), '"projectName":', '"repoName":');
