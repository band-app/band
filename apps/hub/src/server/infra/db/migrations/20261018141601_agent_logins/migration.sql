CREATE TABLE `agent_login_choices` (
	`agent_type` text NOT NULL,
	`repo` text DEFAULT '' NOT NULL,
	`login_id` text NOT NULL,
	CONSTRAINT `agent_login_choices_pk` PRIMARY KEY(`agent_type`, `repo`)
);
--> statement-breakpoint
CREATE TABLE `agent_logins` (
	`id` text PRIMARY KEY,
	`agent_type` text NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`vault_item_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_logins_agent_type_idx` ON `agent_logins` (`agent_type`);