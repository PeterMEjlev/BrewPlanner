CREATE TABLE `brew_session_stage_markers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brew_session_id` integer NOT NULL,
	`stage_index` integer NOT NULL,
	`name` text NOT NULL,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`brew_session_id`) REFERENCES `brew_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brew_session_stage_markers_session_stage_unique` ON `brew_session_stage_markers` (`brew_session_id`,`stage_index`);