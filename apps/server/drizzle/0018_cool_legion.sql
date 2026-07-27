CREATE TABLE `bruce_conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bruce_conversations_updated_idx` ON `bruce_conversations` (`updated_at`);--> statement-breakpoint
INSERT INTO `bruce_conversations` (`id`, `title`) SELECT 1, 'Earlier questions' WHERE EXISTS (SELECT 1 FROM `bruce_messages`);--> statement-breakpoint
CREATE TABLE `__new_bruce_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`sources` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `bruce_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_bruce_messages` (`id`, `conversation_id`, `role`, `content`, `sources`, `created_at`) SELECT `id`, 1, `role`, `content`, `sources`, `created_at` FROM `bruce_messages`;--> statement-breakpoint
DROP TABLE `bruce_messages`;--> statement-breakpoint
ALTER TABLE `__new_bruce_messages` RENAME TO `bruce_messages`;--> statement-breakpoint
CREATE INDEX `bruce_messages_created_idx` ON `bruce_messages` (`created_at`);--> statement-breakpoint
CREATE INDEX `bruce_messages_conversation_idx` ON `bruce_messages` (`conversation_id`,`id`);
