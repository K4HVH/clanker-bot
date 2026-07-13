CREATE TABLE `verification_challenges` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`code` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
