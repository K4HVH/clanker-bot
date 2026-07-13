CREATE TABLE `guild_config` (
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `key`)
);
