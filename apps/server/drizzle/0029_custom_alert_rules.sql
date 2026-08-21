CREATE TABLE `alert_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`name` text NOT NULL,
	`signal` text NOT NULL,
	`test` text NOT NULL,
	`hold_minutes` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `alerts` ADD `rule_id` text;
