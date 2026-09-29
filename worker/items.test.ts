import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { items } from "./db/schema";
import { replaceEditions, selectEdition } from "./editions";
import { hydrateItems, insertValuationSources, type SourceInput } from "./items";
import { createTestDb, insertTestItem } from "./test/sqlite-d1";

let context: ReturnType<typeof createTestDb>;
beforeEach(() => {
  context = createTestDb();
  insertTestItem(context.sqlite, "deck");
});
afterEach(() => context.sqlite.close());

const source = (index: number, overrides: Partial<SourceInput> = {}): SourceInput => ({
  type: "sold", title: `Source ${index}`, url: `https://example.com/${index}`, priceCents: index * 100,
  currency: "USD", note: `Note ${index}`, editionKey: null, ...overrides,
});
const rows = () => context.db.select().from(items);

describe("insertValuationSources", () => {
  it("saves 12 annotated sources despite D1's 100-parameter limit", async () => {
    await insertValuationSources(context.db, "deck", Array.from({ length: 12 }, (_, index) => source(index)), "2026-09-29T12:00:00Z");
    expect(context.sqlite.prepare("SELECT count(*) AS n FROM valuation_sources WHERE note IS NOT NULL").get()).toEqual({ n: 12 });
  });
  it("does nothing for an empty list", async () => {
    await insertValuationSources(context.db, "deck", [], "2026-09-29T12:00:00Z");
    expect(context.sqlite.prepare("SELECT count(*) AS n FROM valuation_sources").get()).toEqual({ n: 0 });
  });
});

describe("hydrateItems", () => {
  it("returns notes, edition keys, capture times, newest sources first, editions, and the selection", async () => {
    await insertValuationSources(context.db, "deck", [source(1)], "2026-09-28T12:00:00Z");
    await insertValuationSources(context.db, "deck", [source(2, { editionKey: "reissue", type: "retail" })], "2026-09-29T12:00:00Z");
    await replaceEditions(context.db, "deck", [
      { key: "reissue", label: "Reissue", identificationTips: "", likelihood: 0.3, estimatedLowCents: null, estimatedHighCents: null, retailPriceCents: 6500, listPriceCents: 4500, minimumOfferCents: null, yardSalePriceCents: null, listingTitle: null },
      { key: "original", label: "Original", identificationTips: "", likelihood: 0.7, estimatedLowCents: null, estimatedHighCents: null, retailPriceCents: null, listPriceCents: 45000, minimumOfferCents: null, yardSalePriceCents: null, listingTitle: null },
    ]);
    await selectEdition(context.db, "deck", "reissue");

    const [item] = await hydrateItems(context.db, await rows());
    expect(item.comparables).toEqual([
      { title: "Source 2", url: "https://example.com/2", priceCents: 200, currency: "USD", type: "retail", note: "Note 2", editionKey: "reissue", capturedAt: "2026-09-29T12:00:00Z" },
      { title: "Source 1", url: "https://example.com/1", priceCents: 100, currency: "USD", type: "sold", note: "Note 1", editionKey: null, capturedAt: "2026-09-28T12:00:00Z" },
    ]);
    expect(item.editions.map((edition) => edition.key)).toEqual(["original", "reissue"]);
    expect(item.selectedEditionKey).toBe("reissue");
    expect(item.listPriceCents).toBe(4500);
  });

  it("hydrates older items with no editions or notes", async () => {
    context.sqlite.exec(`INSERT INTO valuation_sources (id, item_id, source_type, title, captured_at)
      VALUES ('old', 'deck', 'active', 'Legacy', '2026-09-01T12:00:00Z')`);
    const [item] = await hydrateItems(context.db, await rows());
    expect(item.editions).toEqual([]);
    expect(item.selectedEditionKey).toBeNull();
    expect(item.comparables[0]).toMatchObject({ title: "Legacy", note: null, editionKey: null });
  });
});
