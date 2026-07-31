CREATE TABLE `brew_day_rig_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brew_day_id` integer NOT NULL,
	`recorded_at` text NOT NULL,
	`bk` real,
	`mlt` real,
	`hlt` real,
	FOREIGN KEY (`brew_day_id`) REFERENCES `brew_days`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brew_day_rig_samples_day_time_idx` ON `brew_day_rig_samples` (`brew_day_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `brew_days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` text,
	`recipe_snapshot` text NOT NULL,
	`status` text DEFAULT 'brewing' NOT NULL,
	`brewed_at` text NOT NULL,
	`duration_minutes` integer,
	`pitched_at` text,
	`packaged_at` text,
	`pre_boil_gravity` text DEFAULT '' NOT NULL,
	`measured_og` text DEFAULT '' NOT NULL,
	`measured_fg` text DEFAULT '' NOT NULL,
	`volume_l` real,
	`mash_temp_c` real,
	`boil_time_min` real,
	`efficiency_pct` real,
	`water_l` real,
	`energy_kwh` real,
	`rating` integer,
	`notes` text DEFAULT '' NOT NULL,
	`tasting_notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `brew_days_brewed_at_idx` ON `brew_days` (`brewed_at`);--> statement-breakpoint
CREATE INDEX `brew_days_recipe_idx` ON `brew_days` (`recipe_id`);