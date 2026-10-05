CREATE TABLE `runner_machines` (
	`id` text PRIMARY KEY,
	`runner_id` text NOT NULL,
	`request_id` text,
	`worker_id` text NOT NULL,
	`handle` text,
	`state` text DEFAULT 'spawning' NOT NULL,
	`spawned_at` integer NOT NULL,
	`last_seen_at` integer,
	`stopping_since` integer,
	`destroyed_at` integer,
	`destroy_attempts` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `runner_machines_state_idx` ON `runner_machines` (`state`);--> statement-breakpoint
CREATE INDEX `runner_machines_worker_idx` ON `runner_machines` (`worker_id`);