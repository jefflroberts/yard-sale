import { eq, inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { applyEditionPrices, bestEdition, resolveEditionSelection, sortEditions, type EditionPriceFields } from "../src/editions";
import type { ItemEdition } from "../src/types";
import { itemEditions, items } from "./db/schema";

export type WorkerDb = ReturnType<typeof drizzle>;
export type ItemRow = typeof items.$inferSelect;

export class EditionSelectionError extends Error {}

export function parseEditionSelection(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("selectedEditionKey" in body)) {
    throw new EditionSelectionError("selectedEditionKey is required.");
  }
  const key = body.selectedEditionKey;
  if (key === null) return null;
  if (typeof key !== "string" || !key || key.length > 200) {
    throw new EditionSelectionError("selectedEditionKey must be an edition key or null.");
  }
  return key;
}

const MAX_EDITIONS = 4;

type PriceFields = Omit<EditionPriceFields, "listingTitle">;
type PriceEvidence = { type: "retail" | "active" | "sold"; priceCents: number | null };

// The agent does not reliably follow pricing rules, so enforce the ones a bad price would break:
// a yard-sale value far below the Marketplace price is a unit error (e.g. "50" meaning 50%), nothing
// is priced above new retail unless a sold listing beats retail, and the three sale prices stay ordered.
export function sanitizePrices<T extends PriceFields>(prices: T, evidence: PriceEvidence[]): T {
  const result = { ...prices };
  if (result.yardSalePriceCents !== null && result.listPriceCents !== null && result.yardSalePriceCents * 10 < result.listPriceCents) {
    result.yardSalePriceCents = null;
  }
  const retail = result.retailPriceCents;
  const soldAboveRetail = retail !== null && evidence.some((source) => source.type === "sold" && (source.priceCents ?? 0) > retail);
  if (retail !== null && !soldAboveRetail) {
    // Scale the prices below a capped one by the same factor so the negotiating spread survives.
    const listFactor = capFactor(result.listPriceCents, retail);
    result.listPriceCents = capAt(result.listPriceCents, retail);
    result.minimumOfferCents = scalePrice(result.minimumOfferCents, listFactor);
    result.yardSalePriceCents = scalePrice(result.yardSalePriceCents, listFactor);
    const rangeFactor = capFactor(result.estimatedHighCents, retail);
    result.estimatedHighCents = capAt(result.estimatedHighCents, retail);
    result.estimatedLowCents = scalePrice(result.estimatedLowCents, rangeFactor);
  }
  result.estimatedLowCents = capAt(result.estimatedLowCents, result.estimatedHighCents);
  result.minimumOfferCents = capAt(result.minimumOfferCents, result.listPriceCents);
  result.yardSalePriceCents = capAt(result.yardSalePriceCents, result.minimumOfferCents ?? result.listPriceCents);
  return result;
}

function capFactor(value: number | null, ceiling: number): number {
  return value === null || value <= ceiling ? 1 : ceiling / value;
}

// Whole dollars from $5 up, quarters below, matching how the agent is told to round sale prices.
function scalePrice(value: number | null, factor: number): number | null {
  if (value === null || factor === 1) return value;
  const scaled = value * factor;
  const step = scaled >= 500 ? 100 : 25;
  return Math.round(scaled / step) * step;
}

function capAt(value: number | null, ceiling: number | null): number | null {
  return value === null || ceiling === null ? value : Math.min(value, ceiling);
}

// Cleans agent edition data before anything is saved: unique non-empty keys, at most four editions,
// comparables pointing only at kept editions, sanitized prices, and top-level prices from the best edition.
export function normalizeCandidateEditions<
  T extends EditionPriceFields & {
    editions: ItemEdition[];
    comparables: Array<PriceEvidence & { editionKey: string | null }>;
  },
>(candidate: T): T {
  const byKey = new Map<string, ItemEdition>();
  for (const edition of candidate.editions) {
    const key = edition.key.trim();
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || edition.likelihood > existing.likelihood) byKey.set(key, { ...edition, key });
  }
  const keptEditions = sortEditions([...byKey.values()]).slice(0, MAX_EDITIONS);
  const keptKeys = new Set(keptEditions.map((edition) => edition.key));
  const comparables = candidate.comparables.map((comparable) => {
    const key = comparable.editionKey?.trim() ?? null;
    return { ...comparable, editionKey: key !== null && keptKeys.has(key) ? key : null };
  });
  const editions = keptEditions.map((edition) =>
    sanitizePrices(edition, comparables.filter((comparable) => comparable.editionKey === null || comparable.editionKey === edition.key)),
  );
  const best = bestEdition(editions);
  const normalized = { ...candidate, editions, comparables };
  return best ? applyEditionPrices(normalized, best) : sanitizePrices(normalized, comparables);
}

export async function replaceEditions(db: WorkerDb, itemId: string, editions: ItemEdition[]): Promise<void> {
  await db.delete(itemEditions).where(eq(itemEditions.itemId, itemId));
  if (editions.length === 0) return;
  // Four editions × 13 columns stays under D1's 100-parameter limit.
  await db.insert(itemEditions).values(editions.map((edition) => ({ id: crypto.randomUUID(), itemId, ...edition })));
}

export async function loadEditions(db: WorkerDb, itemIds: string[]): Promise<Map<string, ItemEdition[]>> {
  const editionMap = new Map<string, ItemEdition[]>();
  if (itemIds.length === 0) return editionMap;
  const rows = await db.select().from(itemEditions).where(inArray(itemEditions.itemId, itemIds));
  for (const row of rows) {
    const edition: ItemEdition = {
      key: row.key,
      label: row.label,
      identificationTips: row.identificationTips,
      likelihood: row.likelihood,
      estimatedLowCents: row.estimatedLowCents,
      estimatedHighCents: row.estimatedHighCents,
      retailPriceCents: row.retailPriceCents,
      listPriceCents: row.listPriceCents,
      minimumOfferCents: row.minimumOfferCents,
      yardSalePriceCents: row.yardSalePriceCents,
      listingTitle: row.listingTitle,
    };
    editionMap.set(row.itemId, [...(editionMap.get(row.itemId) ?? []), edition]);
  }
  for (const [itemId, editions] of editionMap) editionMap.set(itemId, sortEditions(editions));
  return editionMap;
}

export async function syncSelectedEdition(db: WorkerDb, itemId: string): Promise<ItemRow> {
  const row = await findItem(db, itemId);
  if (!row) throw new Error("Saved item disappeared before its editions were synced.");
  if (row.selectedEditionKey === null) return row;
  const editions = (await loadEditions(db, [itemId])).get(itemId) ?? [];
  const { selectedEditionKey, edition } = resolveEditionSelection(editions, row.selectedEditionKey);
  // A choice that no longer exists is cleared, keeping the agent's fresh top-level values.
  return saveSelection(db, selectedEditionKey === null ? { ...row, selectedEditionKey } : applyEditionPrices({ ...row, selectedEditionKey }, edition!));
}

export async function selectEdition(db: WorkerDb, itemId: string, requestedKey: string | null): Promise<ItemRow | null> {
  const row = await findItem(db, itemId);
  if (!row) return null;
  const editions = (await loadEditions(db, [itemId])).get(itemId) ?? [];
  if (requestedKey !== null && !editions.some((edition) => edition.key === requestedKey)) {
    throw new EditionSelectionError("That edition does not belong to this find.");
  }
  const { selectedEditionKey, edition } = resolveEditionSelection(editions, requestedKey);
  return saveSelection(db, edition ? applyEditionPrices({ ...row, selectedEditionKey }, edition) : { ...row, selectedEditionKey });
}

function findItem(db: WorkerDb, itemId: string): Promise<ItemRow | undefined> {
  return db.select().from(items).where(eq(items.id, itemId)).limit(1).then((rows) => rows[0]);
}

async function saveSelection(db: WorkerDb, row: ItemRow): Promise<ItemRow> {
  await db
    .update(items)
    .set({
      selectedEditionKey: row.selectedEditionKey,
      estimatedLowCents: row.estimatedLowCents,
      estimatedHighCents: row.estimatedHighCents,
      retailPriceCents: row.retailPriceCents,
      listPriceCents: row.listPriceCents,
      minimumOfferCents: row.minimumOfferCents,
      yardSalePriceCents: row.yardSalePriceCents,
      listingTitle: row.listingTitle,
    })
    .where(eq(items.id, row.id));
  return row;
}
