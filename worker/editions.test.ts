import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ItemEdition } from "../src/types";
import { EditionSelectionError, loadEditions, parseEditionSelection, replaceEditions, selectEdition, syncSelectedEdition } from "./editions";
import { createTestDb, insertTestItem } from "./test/sqlite-d1";

function edition(key: string, likelihood: number, listPriceCents: number, listingTitle: string | null = `${key} title`): ItemEdition {
  return {
    key, label: key, identificationTips: `Check ${key}`, likelihood,
    estimatedLowCents: listPriceCents / 2, estimatedHighCents: listPriceCents, retailPriceCents: null,
    listPriceCents, minimumOfferCents: listPriceCents - 100, yardSalePriceCents: listPriceCents / 4, listingTitle,
  };
}

let context: ReturnType<typeof createTestDb>;
beforeEach(() => {
  context = createTestDb();
  insertTestItem(context.sqlite, "deck", { list_price_cents: 45000, listing_title: "Agent title" });
});
afterEach(() => context.sqlite.close());

const itemRow = () => context.sqlite.prepare("SELECT selected_edition_key, list_price_cents, listing_title FROM items WHERE id = 'deck'").get();

describe("parseEditionSelection", () => {
  it("accepts a non-empty string key or null", () => {
    expect(parseEditionSelection({ selectedEditionKey: "reissue" })).toBe("reissue");
    expect(parseEditionSelection({ selectedEditionKey: null })).toBeNull();
  });
  it("rejects anything else", () => {
    for (const body of [null, "reissue", {}, { selectedEditionKey: "" }, { selectedEditionKey: 3 }, { selectedEditionKey: "x".repeat(201) }]) {
      expect(() => parseEditionSelection(body)).toThrow(EditionSelectionError);
    }
  });
});

describe("replaceEditions / loadEditions", () => {
  it("replaces all editions and loads them sorted by likelihood", async () => {
    await replaceEditions(context.db, "deck", [edition("old", 1, 100)]);
    await replaceEditions(context.db, "deck", [edition("reissue", 0.4, 4500), edition("original", 0.6, 45000)]);
    const loaded = await loadEditions(context.db, ["deck", "missing"]);
    expect(loaded.get("deck")?.map((e) => e.key)).toEqual(["original", "reissue"]);
    expect(loaded.get("deck")?.[0]).toEqual(edition("original", 0.6, 45000));
    expect(loaded.get("missing")).toBeUndefined();
  });
  it("clears editions when the new scan has none", async () => {
    await replaceEditions(context.db, "deck", [edition("original", 1, 100)]);
    await replaceEditions(context.db, "deck", []);
    expect((await loadEditions(context.db, ["deck"])).get("deck")).toBeUndefined();
  });
});

describe("selectEdition", () => {
  beforeEach(async () => {
    await replaceEditions(context.db, "deck", [edition("original", 0.6, 45000), edition("reissue", 0.4, 4500, null)]);
  });

  it("stores the key and copies that edition's prices, keeping the title when the edition has none", async () => {
    const row = await selectEdition(context.db, "deck", "reissue");
    expect(row?.selectedEditionKey).toBe("reissue");
    expect(itemRow()).toEqual({ selected_edition_key: "reissue", list_price_cents: 4500, listing_title: "Agent title" });
  });

  it("resets to the best edition for null", async () => {
    await selectEdition(context.db, "deck", "reissue");
    await selectEdition(context.db, "deck", null);
    expect(itemRow()).toEqual({ selected_edition_key: null, list_price_cents: 45000, listing_title: "original title" });
  });

  it("rejects keys the item does not have without changing it", async () => {
    await expect(selectEdition(context.db, "deck", "someone-elses")).rejects.toThrow(EditionSelectionError);
    expect(itemRow()).toEqual({ selected_edition_key: null, list_price_cents: 45000, listing_title: "Agent title" });
  });

  it("returns null for a missing item", async () => {
    expect(await selectEdition(context.db, "nope", null)).toBeNull();
  });
});

describe("syncSelectedEdition (rescan)", () => {
  it("re-applies the user's choice when the new scan still has that key", async () => {
    await replaceEditions(context.db, "deck", [edition("original", 0.6, 45000), edition("reissue", 0.4, 4500)]);
    await selectEdition(context.db, "deck", "reissue");
    // Rescan: agent writes new top-level values, then new editions.
    context.sqlite.exec("UPDATE items SET list_price_cents = 50000, listing_title = 'New agent title' WHERE id = 'deck'");
    await replaceEditions(context.db, "deck", [edition("original", 0.7, 50000), edition("reissue", 0.3, 5000)]);
    const row = await syncSelectedEdition(context.db, "deck");
    expect(row.selectedEditionKey).toBe("reissue");
    expect(itemRow()).toEqual({ selected_edition_key: "reissue", list_price_cents: 5000, listing_title: "reissue title" });
  });

  it("clears the choice and keeps the agent's values when the key is gone", async () => {
    await replaceEditions(context.db, "deck", [edition("reissue", 1, 4500)]);
    await selectEdition(context.db, "deck", "reissue");
    context.sqlite.exec("UPDATE items SET list_price_cents = 50000, listing_title = 'New agent title' WHERE id = 'deck'");
    await replaceEditions(context.db, "deck", [edition("original", 1, 45000)]);
    const row = await syncSelectedEdition(context.db, "deck");
    expect(row.selectedEditionKey).toBeNull();
    expect(itemRow()).toEqual({ selected_edition_key: null, list_price_cents: 50000, listing_title: "New agent title" });
  });

  it("leaves items without a choice untouched", async () => {
    await replaceEditions(context.db, "deck", [edition("reissue", 1, 4500)]);
    await syncSelectedEdition(context.db, "deck");
    expect(itemRow()).toEqual({ selected_edition_key: null, list_price_cents: 45000, listing_title: "Agent title" });
  });
});
