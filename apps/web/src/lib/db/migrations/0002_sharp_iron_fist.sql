CREATE TABLE `loop_iterations` (
	`id` text PRIMARY KEY NOT NULL,
	`loop_id` text NOT NULL,
	`iteration` integer NOT NULL,
	`status` text NOT NULL,
	`output` text,
	`exit_code` integer,
	`promise_detected` integer DEFAULT false NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `loops` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project` text NOT NULL,
	`branch` text NOT NULL,
	`prompt` text NOT NULL,
	`completion_promise` text NOT NULL,
	`max_iterations` integer NOT NULL,
	`current_iteration` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
