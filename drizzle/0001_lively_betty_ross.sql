CREATE TABLE `cases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`case_number` integer NOT NULL,
	`user_id` text NOT NULL,
	`moderator_id` text NOT NULL,
	`type` text NOT NULL,
	`reason` text NOT NULL,
	`meta` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cases_guild_case_idx` ON `cases` (`guild_id`,`case_number`);