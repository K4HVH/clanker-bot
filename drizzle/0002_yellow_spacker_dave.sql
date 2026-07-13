CREATE TABLE `scheduled_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`type` text NOT NULL,
	`user_id` text NOT NULL,
	`reason` text,
	`run_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_actions_run_at_idx` ON `scheduled_actions` (`run_at`);