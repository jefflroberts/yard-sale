import type { DetectedItem, ItemEdition } from "./types";

export type EditionPriceFields = Pick<
  ItemEdition,
  "estimatedLowCents" | "estimatedHighCents" | "retailPriceCents" | "listPriceCents" | "minimumOfferCents" | "yardSalePriceCents" | "listingTitle"
>;

export function sortEditions(editions: ItemEdition[]): ItemEdition[] {
  return [...editions].sort((left, right) => right.likelihood - left.likelihood);
}

export function bestEdition(editions: ItemEdition[]): ItemEdition | null {
  return sortEditions(editions)[0] ?? null;
}

export function activeEditionKey(item: Pick<DetectedItem, "editions" | "selectedEditionKey">): string | null {
  return item.selectedEditionKey ?? bestEdition(item.editions)?.key ?? null;
}

export function applyEditionPrices<T extends EditionPriceFields>(target: T, edition: ItemEdition): T {
  return {
    ...target,
    estimatedLowCents: edition.estimatedLowCents,
    estimatedHighCents: edition.estimatedHighCents,
    retailPriceCents: edition.retailPriceCents,
    listPriceCents: edition.listPriceCents,
    minimumOfferCents: edition.minimumOfferCents,
    yardSalePriceCents: edition.yardSalePriceCents,
    // Buy-mode editions have no title; keep whatever the item already has.
    listingTitle: edition.listingTitle ?? target.listingTitle,
  };
}

// A known key is kept; null or a key that no longer exists falls back to the best guess with no stored choice.
export function resolveEditionSelection(
  editions: ItemEdition[],
  requestedKey: string | null,
): { selectedEditionKey: string | null; edition: ItemEdition | null } {
  const requested = requestedKey === null ? undefined : editions.find((edition) => edition.key === requestedKey);
  if (requested) return { selectedEditionKey: requested.key, edition: requested };
  return { selectedEditionKey: null, edition: bestEdition(editions) };
}

export function withEditionSelection(item: DetectedItem, requestedKey: string | null): DetectedItem {
  const { selectedEditionKey, edition } = resolveEditionSelection(item.editions, requestedKey);
  const next = { ...item, selectedEditionKey };
  return edition ? applyEditionPrices(next, edition) : next;
}
