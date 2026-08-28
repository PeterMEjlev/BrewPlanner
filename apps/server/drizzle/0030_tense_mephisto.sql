CREATE TABLE `todo_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
-- ON DELETE SET NULL is added by hand: drizzle-kit drops the action when it
-- emits ALTER TABLE ... ADD COLUMN for SQLite, though the schema and the
-- snapshot beside this file both carry it. Without it, deleting a category
-- that still has tasks fails on the foreign key instead of letting them fall
-- back to Uncategorised, which is the whole point of the column being nullable.
ALTER TABLE `todos` ADD `category_id` integer REFERENCES todo_categories(id) ON DELETE SET NULL;