UPDATE `worktree_statuses` SET `agent_status` = 'done' WHERE `agent_status` = 'needs_attention';--> statement-breakpoint
UPDATE `worktree_statuses` SET `agent_status` = 'idle' WHERE `agent_status` = 'waiting';--> statement-breakpoint
UPDATE `worktree_status_sources` SET `status` = 'done' WHERE `status` = 'needs_attention';--> statement-breakpoint
UPDATE `worktree_status_sources` SET `status` = 'idle' WHERE `status` = 'waiting';