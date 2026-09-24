DROP INDEX `items_fingerprint_unique`;--> statement-breakpoint
ALTER TABLE `items` ADD `mode` text DEFAULT 'buy' NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `list_price_cents` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `minimum_offer_cents` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `yard_sale_price_cents` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `listing_title` text;--> statement-breakpoint
ALTER TABLE `items` ADD `listing_description` text;--> statement-breakpoint
CREATE UNIQUE INDEX `items_mode_fingerprint_unique` ON `items` (`mode`,`fingerprint`);