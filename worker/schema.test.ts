import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, insertTestItem } from "./test/sqlite-d1";

let context: ReturnType<typeof createTestDb>;
afterEach(() => context.sqlite.close());

describe("migration 0005", () => {
  it("adds item editions that are unique per item key and cascade with their item", () => {
    context = createTestDb();
    const { sqlite } = context;
    insertTestItem(sqlite, "deck");
    const insertEdition = sqlite.prepare(
      "INSERT INTO item_editions (id, item_id, key, label, identification_tips, likelihood) VALUES (?, 'deck', ?, 'Label', 'Tips', 0.5)",
    );
    insertEdition.run("e1", "original");
    expect(() => insertEdition.run("e2", "original")).toThrow("UNIQUE");
    sqlite.exec("DELETE FROM items WHERE id = 'deck'");
    expect(sqlite.prepare("SELECT count(*) AS n FROM item_editions").get()).toEqual({ n: 0 });
  });

  it("adds nullable note and edition key to sources and a selected edition key to items", () => {
    context = createTestDb();
    const { sqlite } = context;
    insertTestItem(sqlite, "deck");
    sqlite.exec(`INSERT INTO valuation_sources (id, item_id, source_type, title, captured_at)
      VALUES ('s1', 'deck', 'sold', 'Old source', '2026-09-29T12:00:00Z')`);
    expect(sqlite.prepare("SELECT note, edition_key FROM valuation_sources").get()).toEqual({ note: null, edition_key: null });
    expect(sqlite.prepare("SELECT selected_edition_key FROM items").get()).toEqual({ selected_edition_key: null });
  });
});
