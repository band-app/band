CREATE TABLE `retro_proposals` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`error` text,
	`chat_id` text,
	`items` text NOT NULL,
	CONSTRAINT `fk_retro_proposals_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `retro_proposals_project_idx` ON `retro_proposals` (`project_id`,`created_at`);