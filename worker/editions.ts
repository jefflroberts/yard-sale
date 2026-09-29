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

// Cleans agent edition data before anything is saved: unique non-empty keys, at most four editions,
// comparables pointing only at kept editions, and top-level prices taken from the best edition.
export function normalizeCandidateEditions<
  T extends EditionPriceFields & { editions: ItemEdition[]; comparables: Array<{ editionKey: string | null }> },
>(candidate: T): T {
  const byKey = new Map<string, ItemEdition>();
  for (const edition of candidate.editions) {
    const key = edition.key.trim();
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || edition.likelihood > existing.likelihood) byKey.set(key, { ...edition, key });
  }
  const editions = sortEditions([...byKey.values()]).slice(0, MAX_EDITIONS);
  const keptKeys = new Set(editions.map((edition) => edition.key));
  const comparables = candidate.comparables.map((comparable) => {
    const key = comparable.editionKey?.trim() ?? null;
    return { ...comparable, editionKey: key !== null && keptKeys.has(key) ? key : null };
  });
  const normalized = { ...candidate, editions, comparables };
  const best = bestEdition(editions);
  return best ? applyEditionPrices(normalized, best) : normalized;
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
