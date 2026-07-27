CREATE TABLE `recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text DEFAULT 'local' NOT NULL,
	`brewers_friend_id` text,
	`brewers_friend_url` text DEFAULT '' NOT NULL,
	`recipe` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recipes_created_at_idx` ON `recipes` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `recipes_brewers_friend_id_unq` ON `recipes` (`brewers_friend_id`);