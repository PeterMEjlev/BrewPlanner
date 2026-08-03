ALTER TABLE `brew_days` RENAME TO `brew_sessions`;--> statement-breakpoint
ALTER TABLE `brew_day_rig_samples` RENAME TO `brew_session_rig_samples`;--> statement-breakpoint
ALTER TABLE `brew_session_rig_samples` RENAME COLUMN `brew_day_id` TO `brew_session_id`;--> statement-breakpoint
DROP INDEX `brew_days_brewed_at_idx`;--> statement-breakpoint
DROP INDEX `brew_days_recipe_idx`;--> statement-breakpoint
DROP INDEX `brew_day_rig_samples_day_time_idx`;--> statement-breakpoint
CREATE INDEX `brew_sessions_brewed_at_idx` ON `brew_sessions` (`brewed_at`);--> statement-breakpoint
CREATE INDEX `brew_sessions_recipe_idx` ON `brew_sessions` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `brew_session_rig_samples_session_time_idx` ON `brew_session_rig_samples` (`brew_session_id`,`recorded_at`);
