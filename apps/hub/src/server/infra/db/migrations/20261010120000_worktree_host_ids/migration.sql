-- A worktree id is `<repo>-<branch>` on the local host and `<repo>-<branch>@<host id>` elsewhere, so the same
-- branch on two hosts is two worktrees. Rewrite the stored ids of worktrees on other hosts. Where several
-- hosts share one old id, state that names no host goes to the lowest host id.
CREATE TABLE `_wt_id_map` (`old_id` text PRIMARY KEY NOT NULL, `new_id` text NOT NULL);--> statement-breakpoint
INSERT INTO `_wt_id_map` (`old_id`, `new_id`)
SELECT old_id, old_id || '@' || MIN(host_id) FROM (
  SELECT repo_name || '-' || REPLACE(name, '/', '-') AS old_id, host_id FROM worktrees
) WHERE host_id <> 'local'
  AND old_id NOT IN (SELECT repo_name || '-' || REPLACE(name, '/', '-') FROM worktrees WHERE host_id = 'local')
GROUP BY old_id;--> statement-breakpoint
UPDATE `worktree_statuses` SET `worktree_id` = `worktree_id` || '@' || `host_id`
WHERE `host_id` <> 'local'
  AND `worktree_id` IN (SELECT w.repo_name || '-' || REPLACE(w.name, '/', '-') FROM worktrees w WHERE w.host_id = `worktree_statuses`.`host_id`);--> statement-breakpoint
UPDATE `worktree_sleep` SET `worktree_id` = `worktree_id` || '@' || `host_id`
WHERE `host_id` <> 'local'
  AND `worktree_id` IN (SELECT w.repo_name || '-' || REPLACE(w.name, '/', '-') FROM worktrees w WHERE w.host_id = `worktree_sleep`.`host_id`);--> statement-breakpoint
UPDATE `usage_events` SET `worktree_id` = `worktree_id` || '@' || `host_id`
WHERE `host_id` <> 'local'
  AND `worktree_id` IN (SELECT w.repo_name || '-' || REPLACE(w.name, '/', '-') FROM worktrees w WHERE w.host_id = `usage_events`.`host_id`);--> statement-breakpoint
UPDATE `usage_scan_state` SET `worktree_id` = `worktree_id` || '@' || `host_id`
WHERE `host_id` <> 'local'
  AND `worktree_id` IN (SELECT w.repo_name || '-' || REPLACE(w.name, '/', '-') FROM worktrees w WHERE w.host_id = `usage_scan_state`.`host_id`);--> statement-breakpoint
UPDATE `worktree_status_sources` SET `worktree_id` = (SELECT new_id FROM _wt_id_map WHERE old_id = `worktree_status_sources`.`worktree_id`) WHERE `worktree_id` IN (SELECT old_id FROM _wt_id_map);--> statement-breakpoint
UPDATE `branch_statuses` SET `worktree_id` = (SELECT new_id FROM _wt_id_map WHERE old_id = `branch_statuses`.`worktree_id`) WHERE `worktree_id` IN (SELECT old_id FROM _wt_id_map);--> statement-breakpoint
UPDATE `tasks` SET `worktree_id` = (SELECT new_id FROM _wt_id_map WHERE old_id = `tasks`.`worktree_id`) WHERE `worktree_id` IN (SELECT old_id FROM _wt_id_map);--> statement-breakpoint
UPDATE `panel_states` SET `worktree_id` = (SELECT new_id FROM _wt_id_map WHERE old_id = `panel_states`.`worktree_id`) WHERE `worktree_id` IN (SELECT old_id FROM _wt_id_map);--> statement-breakpoint
UPDATE `cronjobs` SET `worktree_id` = (SELECT new_id FROM _wt_id_map WHERE old_id = `cronjobs`.`worktree_id`) WHERE `worktree_id` IN (SELECT old_id FROM _wt_id_map);--> statement-breakpoint
UPDATE `browser_history` SET `worktree_id` = (SELECT new_id FROM _wt_id_map WHERE old_id = `browser_history`.`worktree_id`) WHERE `worktree_id` IN (SELECT old_id FROM _wt_id_map);--> statement-breakpoint
UPDATE `agent_sessions` SET `worktree_id` = (SELECT new_id FROM _wt_id_map WHERE old_id = `agent_sessions`.`worktree_id`) WHERE `worktree_id` IN (SELECT old_id FROM _wt_id_map);--> statement-breakpoint
UPDATE `subscriptions` SET `worktree_id` = (SELECT new_id FROM _wt_id_map WHERE old_id = `subscriptions`.`worktree_id`) WHERE `worktree_id` IN (SELECT old_id FROM _wt_id_map);--> statement-breakpoint
UPDATE `pushed_shas` SET `worktree_id` = (SELECT new_id FROM _wt_id_map WHERE old_id = `pushed_shas`.`worktree_id`) WHERE `worktree_id` IN (SELECT old_id FROM _wt_id_map);--> statement-breakpoint
UPDATE `worktrees` SET `origin_worktree_id` = (SELECT new_id FROM _wt_id_map WHERE old_id = `worktrees`.`origin_worktree_id`) WHERE `origin_worktree_id` IN (SELECT old_id FROM _wt_id_map);--> statement-breakpoint
UPDATE `cronjobs` SET `file_key` = (SELECT new_id FROM _wt_id_map WHERE old_id = `cronjobs`.`file_key`) WHERE `scope` = 'worktree' AND `file_key` IN (SELECT old_id FROM _wt_id_map);--> statement-breakpoint
UPDATE `client_state` SET
  `key` = substr(`key`, 1, instr(`key`, `worktree_id`) - 1) || (SELECT new_id FROM _wt_id_map WHERE old_id = `client_state`.`worktree_id`) || substr(`key`, instr(`key`, `worktree_id`) + length(`worktree_id`)),
  `worktree_id` = (SELECT new_id FROM _wt_id_map WHERE old_id = `client_state`.`worktree_id`)
WHERE `worktree_id` IN (SELECT old_id FROM _wt_id_map) AND instr(`key`, `worktree_id`) > 0;--> statement-breakpoint
DROP TABLE `_wt_id_map`;
