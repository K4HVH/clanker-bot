CREATE TABLE `tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`ticket_number` integer NOT NULL,
	`channel_id` text NOT NULL,
	`opener_id` text NOT NULL,
	`subject` text NOT NULL,
	`status` text NOT NULL,
	`transcript` text,
	`created_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_channel_idx` ON `tickets` (`channel_id`);