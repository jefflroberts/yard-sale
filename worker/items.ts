import { desc, inArray } from "drizzle-orm";
import type { Comparable, DetectedItem } from "../src/types";
import { valuationSources } from "./db/schema";
import { loadEditions, type ItemRow, type WorkerDb } from "./editions";

// Enough for several rescans of 12 sources; the UI shows the latest scan and folds the rest.
export const MAX_SOURCES_PER_ITEM = 48;
// Ten columns per row keeps each insert at or under D1's 100 bound parameters.
const SOURCE_INSERT_CHUNK = 10;

export type SourceInput = Pick<Comparable, "type" | "title" | "url" | "priceCents" | "currency" | "note" | "editionKey">;

export async function insertValuationSources(db: WorkerDb, itemId: string, sources: SourceInput[], capturedAt: string): Promise<void> {
  const rows = sources.map((source) => ({
    id: crypto.randomUUID(),
    itemId,
    sourceType: source.type,
    title: source.title,
    url: source.url,
    priceCents: source.priceCents,
    currency: source.currency,
    note: source.note,
    editionKey: source.editionKey,
    capturedAt,
  }));
  for (let index = 0; index < rows.length; index += SOURCE_INSERT_CHUNK) {
    await db.insert(valuationSources).values(rows.slice(index, index + SOURCE_INSERT_CHUNK));
  }
}

export async function hydrateItems(db: WorkerDb, rows: ItemRow[]): Promise<DetectedItem[]> {
  const ids = rows.map((row) => row.id);
  const [sources, editionMap] = await Promise.all([
    ids.length === 0
      ? []
      : db
          .select()
          .from(valuationSources)
          .where(inArray(valuationSources.itemId, ids))
          .orderBy(desc(valuationSources.capturedAt)),
    loadEditions(db, ids),
  ]);
  const sourceMap = new Map<string, Comparable[]>();
  for (const source of sources) {
    const comparables = sourceMap.get(source.itemId) ?? [];
    if (comparables.length < MAX_SOURCES_PER_ITEM) {
      comparables.push({
        title: source.title,
        url: source.url,
        priceCents: source.priceCents,
        currency: source.currency,
        type: source.sourceType,
        note: source.note,
        editionKey: source.editionKey,
        capturedAt: source.capturedAt,
      });
      sourceMap.set(source.itemId, comparables);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    scanSessionId: row.scanSessionId,
    fingerprint: row.fingerprint,
    name: row.name,
    category: row.category,
    brand: row.brand,
    model: row.model,
    description: row.description,
    condition: row.condition,
    confidence: row.confidence,
    observedPriceCents: row.observedPriceCents,
    currency: row.currency,
    estimatedLowCents: row.estimatedLowCents,
    estimatedHighCents: row.estimatedHighCents,
    retailPriceCents: row.retailPriceCents,
    activePriceCents: row.activePriceCents,
    soldPriceCents: row.soldPriceCents,
    mode: row.mode,
    listPriceCents: row.listPriceCents,
    minimumOfferCents: row.minimumOfferCents,
    yardSalePriceCents: row.yardSalePriceCents,
    listingTitle: row.listingTitle,
    listingDescription: row.listingDescription,
    valueSummary: row.valueSummary,
    thumbnailUrl: `/api/thumbnails/${row.thumbnailKey}`,
    boundingBox:
      row.boxXMin === null || row.boxYMin === null || row.boxXMax === null || row.boxYMax === null
        ? null
        : { xMin: row.boxXMin, yMin: row.boxYMin, xMax: row.boxXMax, yMax: row.boxYMax },
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    seenCount: row.seenCount,
    duplicate: row.seenCount > 1,
    comparables: sourceMap.get(row.id) ?? [],
    editions: editionMap.get(row.id) ?? [],
    selectedEditionKey: row.selectedEditionKey,
  }));
}
