ALTER TABLE `recipes` ADD `family_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `recipes` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `recipes` ADD `version_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `recipes_family_idx` ON `recipes` (`family_id`,`version`);--> statement-breakpoint
-- Every recipe written before versioning is version 1 of its own family.
UPDATE `recipes` SET `family_id` = `id` WHERE `family_id` = '';
