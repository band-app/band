DROP INDEX IF EXISTS `agent_logins_agent_type_idx`;--> statement-breakpoint
DROP TABLE `agent_login_choices`;--> statement-breakpoint
DROP TABLE `agent_logins`;--> statement-breakpoint
UPDATE `vault_items` SET `kind` = 'api_key', `metadata` = json_remove(`metadata`, '$.host', '$.pathPattern', '$.username') WHERE `kind` = 'git';--> statement-breakpoint
UPDATE `panel_states` SET `state` = json_remove(`state`, '$.loginId') WHERE json_valid(`state`) AND json_extract(`state`, '$.loginId') IS NOT NULL;
