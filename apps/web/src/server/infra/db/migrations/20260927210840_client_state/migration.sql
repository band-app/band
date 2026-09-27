CREATE TABLE `client_state` (
	`key` text NOT NULL,
	`scope` text NOT NULL,
	`workspace_id` text,
	`value` text,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `client_state_pk` PRIMARY KEY(`key`, `scope`)
);
--> statement-breakpoint
CREATE INDEX `client_state_workspace_idx` ON `client_state` (`workspace_id`);