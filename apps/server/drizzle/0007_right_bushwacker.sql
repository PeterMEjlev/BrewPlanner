CREATE TABLE `device_commands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer NOT NULL,
	`command` text NOT NULL,
	`value` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_commands_device_status_idx` ON `device_commands` (`device_id`,`status`);