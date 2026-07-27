CREATE TABLE `ingredient_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`ingredient` text NOT NULL,
	`label` text NOT NULL,
	`catalogue_id` text,
	`unit_price_dkk` real,
	`price_unit` text,
	`package_size_g` real,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingredient_prices_kind_ingredient_unq` ON `ingredient_prices` (`kind`,`ingredient`);