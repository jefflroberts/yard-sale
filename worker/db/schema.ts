import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { SCAN_MODES } from "../mode";

export const scanSessions = sqliteTable("scan_sessions", {
  id: text("id").primaryKey(),
  sourceType: text("source_type", { enum: ["camera", "video", "image"] }).notNull(),
  sourceName: text("source_name"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
});

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    scanSessionId: text("scan_session_id")
      .notNull()
      .references(() => scanSessions.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    brand: text("brand"),
    model: text("model"),
    description: text("description").notNull(),
    condition: text("condition").notNull(),
    confidence: real("confidence").notNull(),
    observedPriceCents: integer("observed_price_cents"),
    currency: text("currency").notNull().default("USD"),
    estimatedLowCents: integer("estimated_low_cents"),
    estimatedHighCents: integer("estimated_high_cents"),
    retailPriceCents: integer("retail_price_cents"),
    activePriceCents: integer("active_price_cents"),
    soldPriceCents: integer("sold_price_cents"),
    mode: text("mode", { enum: SCAN_MODES }).notNull().default("buy"),
    listPriceCents: integer("list_price_cents"),
    minimumOfferCents: integer("minimum_offer_cents"),
    yardSalePriceCents: integer("yard_sale_price_cents"),
    listingTitle: text("listing_title"),
    listingDescription: text("listing_description"),
    selectedEditionKey: text("selected_edition_key"),
    valueSummary: text("value_summary").notNull(),
    thumbnailKey: text("thumbnail_key").notNull(),
    boxXMin: integer("box_x_min"),
    boxYMin: integer("box_y_min"),
    boxXMax: integer("box_x_max"),
    boxYMax: integer("box_y_max"),
    rawJson: text("raw_json").notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    seenCount: integer("seen_count").notNull().default(1),
  },
  (table) => [
    uniqueIndex("items_mode_fingerprint_unique").on(table.mode, table.fingerprint),
    index("items_session_idx").on(table.scanSessionId),
    index("items_last_seen_idx").on(table.lastSeenAt),
  ],
);

export const valuationSources = sqliteTable(
  "valuation_sources",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    sourceType: text("source_type", { enum: ["retail", "active", "sold"] }).notNull(),
    title: text("title").notNull(),
    url: text("url"),
    priceCents: integer("price_cents"),
    currency: text("currency").notNull().default("USD"),
    note: text("note"),
    editionKey: text("edition_key"),
    capturedAt: text("captured_at").notNull(),
  },
  (table) => [index("valuation_sources_item_idx").on(table.itemId)],
);

export const itemEditions = sqliteTable(
  "item_editions",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    identificationTips: text("identification_tips").notNull(),
    likelihood: real("likelihood").notNull(),
    estimatedLowCents: integer("estimated_low_cents"),
    estimatedHighCents: integer("estimated_high_cents"),
    retailPriceCents: integer("retail_price_cents"),
    listPriceCents: integer("list_price_cents"),
    minimumOfferCents: integer("minimum_offer_cents"),
    yardSalePriceCents: integer("yard_sale_price_cents"),
    listingTitle: text("listing_title"),
  },
  (table) => [uniqueIndex("item_editions_item_key_unique").on(table.itemId, table.key)],
);

export const frameRuns = sqliteTable(
  "frame_runs",
  {
    id: text("id").primaryKey(),
    scanSessionId: text("scan_session_id")
      .notNull()
      .references(() => scanSessions.id, { onDelete: "cascade" }),
    thumbnailKey: text("thumbnail_key"),
    capturedAt: text("captured_at").notNull(),
    completedAt: text("completed_at"),
    latencyMs: integer("latency_ms").notNull(),
    itemCount: integer("item_count").notNull(),
    modelCalls: integer("model_calls").notNull(),
    searchesPerformed: integer("searches_performed").notNull(),
    model: text("model"),
    instructions: text("instructions"),
    inputJson: text("input_json"),
    eventsJson: text("events_json"),
    rawResponsesJson: text("raw_responses_json"),
    outputJson: text("output_json"),
    usageJson: text("usage_json"),
    status: text("status", { enum: ["completed", "failed"] }).notNull(),
    error: text("error"),
  },
  (table) => [
    index("frame_runs_session_idx").on(table.scanSessionId),
    index("frame_runs_thumbnail_idx").on(table.thumbnailKey),
  ],
);

export const appStats = sqliteTable("app_stats", {
  id: integer("id").primaryKey(),
  framesProcessed: integer("frames_processed").notNull().default(0),
  itemsIdentified: integer("items_identified").notNull().default(0),
  searchesPerformed: integer("searches_performed").notNull().default(0),
  modelCalls: integer("model_calls").notNull().default(0),
  lastUpdated: text("last_updated"),
});
