CREATE TABLE `tags` (
	`guild_id` text NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `name`)
);
