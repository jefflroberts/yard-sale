CREATE TABLE `item_editions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`identification_tips` text NOT NULL,
	`likelihood` real NOT NULL,
	`estimated_low_cents` integer,
	`estimated_high_cents` integer,
	`retail_price_cents` integer,
	`list_price_cents` integer,
	`minimum_offer_cents` integer,
	`yard_sale_price_cents` integer,
	`listing_title` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_editions_item_key_unique` ON `item_editions` (`item_id`,`key`);--> statement-breakpoint
ALTER TABLE `items` ADD `selected_edition_key` text;--> statement-breakpoint
ALTER TABLE `valuation_sources` ADD `note` text;--> statement-breakpoint
ALTER TABLE `valuation_sources` ADD `edition_key` text;