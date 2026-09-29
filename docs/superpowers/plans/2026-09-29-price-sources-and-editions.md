# Price Sources and Editions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show annotated, edition-aware pricing evidence next to every price, and let the user pick which release (original, reissue, …) of an item they have, with prices following that choice.

**Architecture:** The agent returns a note and optional edition key per comparable plus an `editions` array per item. The worker persists editions in a new `item_editions` table (replaced on each rescan), links sources and the user's choice by edition key, and copies the chosen edition's prices into the item's existing top-level price columns so every existing view keeps working. A pure shared module (`src/editions.ts`) owns edition-selection logic for both the worker and the optimistic UI update.

**Tech Stack:** Cloudflare Workers + D1 (SQLite) via drizzle-orm 0.45, drizzle-kit migrations, `@openai/agents` with zod 4 structured output, React 19 + TanStack Query 5, vitest 3 (tests run under Node 22 with `node:sqlite`).

**Spec:** `docs/superpowers/specs/2026-09-29-price-sources-and-editions-design.md`

## Global Constraints

- Applies to both buy and sell mode.
- No backfill: existing items have `editions: []`, `selectedEditionKey: null`, and comparables with `note: null`, `editionKey: null`.
- Editions max 4 per item; comparables max 12 per scan; source note under ~120 characters.
- Editions are referenced by `key` (never row id) from `valuation_sources.edition_key` and `items.selected_edition_key`.
- `listingDescription` stays shared across editions; `listingTitle` is per edition (sell mode).
- D1 limits a single query to 100 bound parameters — multi-row inserts must be chunked.
- Run `npx vitest run` for tests. `npm run dev` is always running in another terminal; do not run `npm run build` to check frontend changes (use `npx tsc -b --noEmit` for type checks).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Rescanning an item the user already picked an edition for** — the pick must survive and drive top-level prices when the new scan still returns that key; it must clear (and fall back to the agent's values) when the key disappears. Pinned in Task 3.
2. **Saving 12 comparables with the new columns** — 12 rows × 10 columns = 120 params exceeds D1's 100-param limit; the insert must be chunked. The test D1 adapter enforces the limit so Task 4's test fails without chunking.
3. **Old items with no notes/editions/sources from multiple scans** — detail view must render unchanged-looking rows, no picker, and a working "earlier scans" toggle. Pinned in Task 7 (`splitEvidence`) tests.
4. **PATCH with a bad body or a key from a different item** — must return 400, not 500, and must not mutate. Pinned in Task 3.
5. **Failed PATCH after optimistic update** — the UI must roll back to the previous prices and show an error. Pinned by `withEditionSelection` purity tests in Task 1 plus manual check in Task 8.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` (modify) | Add `ItemEdition`; extend `Comparable` and `DetectedItem` |
| `src/editions.ts` (create) | Pure edition logic: sort, best, active key, apply prices, resolve selection |
| `src/editions.test.ts` (create) | Tests for the above |
| `worker/db/schema.ts` (modify) | `itemEditions` table, new columns |
| `migrations/0005_*.sql` (generate) | Migration |
| `worker/test/sqlite-d1.ts` (create) | D1-compatible adapter over `node:sqlite` with real migrations, for tests |
| `worker/editions.ts` (create) | Persist/load editions, sync selection on rescan, PATCH selection |
| `worker/editions.test.ts` (create) | Tests |
| `worker/items.ts` (create) | `hydrateItems` (moved from index.ts) and chunked `insertValuationSources` |
| `worker/items.test.ts` (create) | Tests |
| `worker/agent.ts` (modify) | Schema + prompt rules |
| `worker/mode.test.ts` (modify) | Prompt assertions |
| `worker/index.ts` (modify) | Wire analyze flow + PATCH route |
| `src/market-evidence.ts` (create) | `collectMarketEvidence` (moved) + `splitEvidence` |
| `src/market-evidence.test.ts` (create) | Tests |
| `src/App.tsx` (modify) | Sources section, edition picker, PATCH wiring, card badge |
| `src/styles.css` (modify) | Styles for notes, toggle, picker, badge |

---

### Task 1: Shared edition types and selection logic

**Files:**
- Modify: `src/types.ts`
- Create: `src/editions.ts`
- Test: `src/editions.test.ts`

**Interfaces:**
- Produces:
  - `type ItemEdition = { key: string; label: string; identificationTips: string; likelihood: number; estimatedLowCents: number | null; estimatedHighCents: number | null; retailPriceCents: number | null; listPriceCents: number | null; minimumOfferCents: number | null; yardSalePriceCents: number | null; listingTitle: string | null }`
  - `Comparable` gains `note: string | null; editionKey: string | null; capturedAt: string`
  - `DetectedItem` gains `editions: ItemEdition[]; selectedEditionKey: string | null`
  - `type EditionPriceFields = Pick<ItemEdition, "estimatedLowCents" | "estimatedHighCents" | "retailPriceCents" | "listPriceCents" | "minimumOfferCents" | "yardSalePriceCents" | "listingTitle">`
  - `sortEditions(editions: ItemEdition[]): ItemEdition[]`
  - `bestEdition(editions: ItemEdition[]): ItemEdition | null`
  - `activeEditionKey(item: Pick<DetectedItem, "editions" | "selectedEditionKey">): string | null`
  - `applyEditionPrices<T extends EditionPriceFields>(target: T, edition: ItemEdition): T`
  - `resolveEditionSelection(editions: ItemEdition[], requestedKey: string | null): { selectedEditionKey: string | null; edition: ItemEdition | null }`
  - `withEditionSelection(item: DetectedItem, requestedKey: string | null): DetectedItem`

- [ ] **Step 1: Extend types**

In `src/types.ts`, replace the `Comparable` type and add `ItemEdition` directly after it:

```ts
export type Comparable = {
  title: string;
  url: string | null;
  priceCents: number | null;
  currency: string;
  type: "retail" | "active" | "sold";
  note: string | null;
  editionKey: string | null;
  capturedAt: string;
};

export type ItemEdition = {
  key: string;
  label: string;
  identificationTips: string;
  likelihood: number;
  estimatedLowCents: number | null;
  estimatedHighCents: number | null;
  retailPriceCents: number | null;
  listPriceCents: number | null;
  minimumOfferCents: number | null;
  yardSalePriceCents: number | null;
  listingTitle: string | null;
};
```

In `DetectedItem`, add after `comparables: Comparable[];`:

```ts
  editions: ItemEdition[];
  selectedEditionKey: string | null;
```

- [ ] **Step 2: Write the failing tests**

Create `src/editions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { activeEditionKey, applyEditionPrices, bestEdition, resolveEditionSelection, sortEditions, withEditionSelection } from "./editions";
import type { DetectedItem, ItemEdition } from "./types";

function edition(key: string, likelihood: number, overrides: Partial<ItemEdition> = {}): ItemEdition {
  return {
    key,
    label: key,
    identificationTips: "",
    likelihood,
    estimatedLowCents: 100,
    estimatedHighCents: 200,
    retailPriceCents: 300,
    listPriceCents: 400,
    minimumOfferCents: 350,
    yardSalePriceCents: 150,
    listingTitle: `${key} title`,
    ...overrides,
  };
}

const original = edition("original-1988", 0.6, { listPriceCents: 45000, listingTitle: "Original 1988 deck" });
const reissue = edition("reissue", 0.4, { listPriceCents: 4500, listingTitle: "Reissue deck" });

function item(overrides: Partial<DetectedItem> = {}): DetectedItem {
  return {
    id: "item", scanSessionId: "s", fingerprint: "f", name: "Deck", category: "Skate", brand: null, model: null,
    description: "", condition: "Used", confidence: 1, observedPriceCents: null, currency: "USD",
    estimatedLowCents: 1, estimatedHighCents: 2, retailPriceCents: 3, activePriceCents: null, soldPriceCents: null,
    mode: "sell", listPriceCents: 45000, minimumOfferCents: 5, yardSalePriceCents: 6,
    listingTitle: "Agent title", listingDescription: "Shared", valueSummary: "", thumbnailUrl: "", boundingBox: null,
    firstSeenAt: "", lastSeenAt: "", seenCount: 1, duplicate: false, comparables: [],
    editions: [original, reissue], selectedEditionKey: null,
    ...overrides,
  };
}

describe("sortEditions / bestEdition", () => {
  it("orders by likelihood descending without mutating", () => {
    const input = [reissue, original];
    expect(sortEditions(input).map((e) => e.key)).toEqual(["original-1988", "reissue"]);
    expect(input[0]).toBe(reissue);
    expect(bestEdition(input)?.key).toBe("original-1988");
    expect(bestEdition([])).toBeNull();
  });
});

describe("activeEditionKey", () => {
  it("prefers the user's choice, then the best guess, then null", () => {
    expect(activeEditionKey({ editions: [original, reissue], selectedEditionKey: "reissue" })).toBe("reissue");
    expect(activeEditionKey({ editions: [reissue, original], selectedEditionKey: null })).toBe("original-1988");
    expect(activeEditionKey({ editions: [], selectedEditionKey: null })).toBeNull();
  });
});

describe("applyEditionPrices", () => {
  it("copies price fields and keeps the existing title when the edition has none", () => {
    const target = { estimatedLowCents: 1, estimatedHighCents: 2, retailPriceCents: 3, listPriceCents: 4, minimumOfferCents: 5, yardSalePriceCents: 6, listingTitle: "Keep", other: "x" };
    expect(applyEditionPrices(target, reissue)).toEqual({
      estimatedLowCents: 100, estimatedHighCents: 200, retailPriceCents: 300, listPriceCents: 4500,
      minimumOfferCents: 350, yardSalePriceCents: 150, listingTitle: "Reissue deck", other: "x",
    });
    expect(applyEditionPrices(target, edition("x", 1, { listingTitle: null })).listingTitle).toBe("Keep");
  });
});

describe("resolveEditionSelection", () => {
  it("honors a known key", () => {
    expect(resolveEditionSelection([original, reissue], "reissue")).toEqual({ selectedEditionKey: "reissue", edition: reissue });
  });
  it("falls back to the best edition with no stored key for null or unknown keys", () => {
    expect(resolveEditionSelection([reissue, original], null)).toEqual({ selectedEditionKey: null, edition: original });
    expect(resolveEditionSelection([original], "gone")).toEqual({ selectedEditionKey: null, edition: original });
    expect(resolveEditionSelection([], null)).toEqual({ selectedEditionKey: null, edition: null });
  });
});

describe("withEditionSelection", () => {
  it("returns a new item priced for the chosen edition", () => {
    const before = item();
    const after = withEditionSelection(before, "reissue");
    expect(after).not.toBe(before);
    expect(after.selectedEditionKey).toBe("reissue");
    expect(after.listPriceCents).toBe(4500);
    expect(after.listingTitle).toBe("Reissue deck");
    expect(after.listingDescription).toBe("Shared");
    expect(before.listPriceCents).toBe(45000);
  });
  it("resets to the best edition for null", () => {
    const after = withEditionSelection(item({ selectedEditionKey: "reissue", listPriceCents: 4500 }), null);
    expect(after.selectedEditionKey).toBeNull();
    expect(after.listPriceCents).toBe(45000);
  });
  it("only clears the key when there are no editions", () => {
    const after = withEditionSelection(item({ editions: [], selectedEditionKey: null }), null);
    expect(after.listPriceCents).toBe(45000);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/editions.test.ts`
Expected: FAIL — `Failed to resolve import "./editions"`.

- [ ] **Step 4: Implement**

Create `src/editions.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/editions.test.ts`
Expected: PASS (all tests). `npx tsc -b --noEmit` will report errors in `worker/index.ts` and `src/App.tsx` for the new required fields — expected; Tasks 4, 6 and 7 fix them.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/editions.ts src/editions.test.ts
git commit -m "Add shared edition types and selection logic

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Schema, migration, and SQLite-backed D1 test harness

**Files:**
- Modify: `worker/db/schema.ts`
- Create: `migrations/0005_price_sources_editions.sql` (generated), `migrations/meta/*` (generated)
- Create: `worker/test/sqlite-d1.ts`
- Test: `worker/schema.test.ts`

**Interfaces:**
- Produces:
  - `itemEditions` drizzle table (columns: `id, itemId, key, label, identificationTips, likelihood, estimatedLowCents, estimatedHighCents, retailPriceCents, listPriceCents, minimumOfferCents, yardSalePriceCents, listingTitle`)
  - `items.selectedEditionKey`, `valuationSources.note`, `valuationSources.editionKey`
  - `createTestDb(): { sqlite: DatabaseSync; db: DrizzleD1Database }` — in-memory SQLite with all migrations applied, foreign keys ON, a `scan_sessions` row `'session'`, and a D1 adapter that throws when a statement binds more than 100 parameters.
  - `insertTestItem(sqlite: DatabaseSync, id: string, overrides?: Record<string, string | number | null>): void`

- [ ] **Step 1: Update the drizzle schema**

In `worker/db/schema.ts`, add to the `items` columns after `listingDescription`:

```ts
    selectedEditionKey: text("selected_edition_key"),
```

Add to `valuationSources` columns after `currency`:

```ts
    note: text("note"),
    editionKey: text("edition_key"),
```

Add a new table after `valuationSources`:

```ts
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
```

- [ ] **Step 2: Generate the migration**

Run: `npx drizzle-kit generate --name price_sources_editions`
Expected: creates `migrations/0005_price_sources_editions.sql` containing `CREATE TABLE \`item_editions\`` (with a `FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE cascade`), `CREATE UNIQUE INDEX \`item_editions_item_key_unique\``, `ALTER TABLE \`items\` ADD \`selected_edition_key\` text;`, and two `ALTER TABLE \`valuation_sources\` ADD ...` statements. Open the file and confirm there are no `DROP` statements or table rebuilds.

- [ ] **Step 3: Create the test harness**

Create `worker/test/sqlite-d1.ts`:

```ts
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { drizzle } from "drizzle-orm/d1";

// D1 rejects statements with more than 100 bound parameters; mirror that so tests catch it.
const D1_MAX_PARAMS = 100;

function sqliteD1(sqlite: DatabaseSync): D1Database {
  const prepare = (query: string) => {
    const bound = (params: SQLInputValue[]) => {
      if (params.length > D1_MAX_PARAMS) throw new Error(`too many SQL variables: ${params.length}`);
      const statement = () => sqlite.prepare(query);
      return {
        bind: (...next: unknown[]) => bound(next as SQLInputValue[]),
        all: async () => ({ results: statement().all(...params), success: true, meta: {} }),
        raw: async () => statement().all(...params).map((row) => Object.values(row)),
        first: async () => statement().get(...params) ?? null,
        run: async () => {
          const result = statement().run(...params);
          return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      };
    };
    return bound([]);
  };
  return {
    prepare,
    batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
      const results = [];
      for (const statement of statements) results.push(await statement.all());
      return results;
    },
  } as unknown as D1Database;
}

export function createTestDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = new NodeURL("../../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new NodeURL(file, migrations), "utf8"));
  }
  sqlite.exec("INSERT INTO scan_sessions (id, source_type, started_at) VALUES ('session', 'image', '2026-09-29T12:00:00Z')");
  return { sqlite, db: drizzle(sqliteD1(sqlite)) };
}

export function insertTestItem(sqlite: DatabaseSync, id: string, overrides: Record<string, string | number | null> = {}) {
  const row: Record<string, string | number | null> = {
    id,
    scan_session_id: "session",
    fingerprint: id,
    name: `Item ${id}`,
    category: "Skateboarding",
    description: "A deck",
    condition: "Used",
    confidence: 1,
    value_summary: "",
    thumbnail_key: `frames/session/${id}.jpg`,
    raw_json: "{}",
    first_seen_at: "2026-09-29T12:00:00Z",
    last_seen_at: "2026-09-29T12:00:00Z",
    mode: "sell",
    ...overrides,
  };
  const columns = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO items (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
}
```

- [ ] **Step 4: Write the failing schema test**

Create `worker/schema.test.ts`:

```ts
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
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run worker/schema.test.ts worker/history.test.ts`
Expected: PASS. (If the migration was not generated, the first test fails with `no such table: item_editions`.)

- [ ] **Step 6: Apply locally and commit**

Run: `npm run db:migrate:local`
Expected: `0005_price_sources_editions.sql` applied.

```bash
git add worker/db/schema.ts migrations worker/test/sqlite-d1.ts worker/schema.test.ts
git commit -m "Add item editions table and source note columns

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Edition persistence and selection in the worker

**Files:**
- Create: `worker/editions.ts`
- Test: `worker/editions.test.ts`

**Interfaces:**
- Consumes: `resolveEditionSelection`, `applyEditionPrices`, `sortEditions` from `src/editions.ts`; `ItemEdition` from `src/types.ts`; `itemEditions`, `items` from `worker/db/schema.ts`; `createTestDb`, `insertTestItem` from `worker/test/sqlite-d1.ts`.
- Produces:
  - `type WorkerDb = ReturnType<typeof drizzle>` (drizzle from `drizzle-orm/d1`)
  - `type ItemRow = typeof items.$inferSelect`
  - `class EditionSelectionError extends Error`
  - `parseEditionSelection(body: unknown): string | null` — throws `EditionSelectionError`
  - `replaceEditions(db: WorkerDb, itemId: string, editions: ItemEdition[]): Promise<void>`
  - `loadEditions(db: WorkerDb, itemIds: string[]): Promise<Map<string, ItemEdition[]>>` — each list sorted by likelihood desc
  - `syncSelectedEdition(db: WorkerDb, itemId: string): Promise<ItemRow>` — for rescans
  - `selectEdition(db: WorkerDb, itemId: string, requestedKey: string | null): Promise<ItemRow | null>` — null when the item doesn't exist; throws `EditionSelectionError` for unknown keys

- [ ] **Step 1: Write the failing tests**

Create `worker/editions.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run worker/editions.test.ts`
Expected: FAIL — `Failed to resolve import "./editions"`.

- [ ] **Step 3: Implement**

Create `worker/editions.ts`:

```ts
import { eq, inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { applyEditionPrices, resolveEditionSelection, sortEditions } from "../src/editions";
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run worker/editions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/editions.ts worker/editions.test.ts
git commit -m "Persist item editions and apply the chosen edition's prices

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Item hydration and chunked source inserts

**Files:**
- Create: `worker/items.ts`
- Modify: `worker/index.ts` (remove `hydrateItems`, import it from `./items`)
- Test: `worker/items.test.ts`

**Interfaces:**
- Consumes: `WorkerDb`, `ItemRow`, `loadEditions` from `worker/editions.ts`; `valuationSources` from schema; `createTestDb`, `insertTestItem`.
- Produces:
  - `MAX_SOURCES_PER_ITEM = 48`
  - `type SourceInput = { type: "retail" | "active" | "sold"; title: string; url: string | null; priceCents: number | null; currency: string; note: string | null; editionKey: string | null }`
  - `insertValuationSources(db: WorkerDb, itemId: string, sources: SourceInput[], capturedAt: string): Promise<void>`
  - `hydrateItems(db: WorkerDb, rows: ItemRow[]): Promise<DetectedItem[]>`

- [ ] **Step 1: Write the failing tests**

Create `worker/items.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run worker/items.test.ts`
Expected: FAIL — `Failed to resolve import "./items"`.

- [ ] **Step 3: Implement `worker/items.ts`**

Move `hydrateItems` out of `worker/index.ts` (currently at `worker/index.ts:517-579`) into a new file, changing it to take a db and to add the new fields:

```ts
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
```

- [ ] **Step 4: Update callers in `worker/index.ts`**

- Delete the old `hydrateItems` function.
- Add `import { hydrateItems, insertValuationSources } from "./items";`
- In `getItems`: `items: await hydrateItems(db, page),`
- In `getFrameItems`: `return hydrateItems(db, rows);`
- Remove `valuationSources` and `Comparable` from imports if now unused (the analyze flow still uses `valuationSources` until Task 6 — leave it until then; `tsc` will tell you).

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: PASS for all worker and src tests. `npx tsc -p tsconfig.worker.json --noEmit` may still report the analyze flow's `detectedItems.push({...})` missing `editions`/`selectedEditionKey`/comparable fields — fixed in Task 6.

- [ ] **Step 6: Commit**

```bash
git add worker/items.ts worker/items.test.ts worker/index.ts
git commit -m "Move item hydration to its own module and return editions and source notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Agent schema and prompt rules

**Files:**
- Modify: `worker/agent.ts`
- Test: `worker/mode.test.ts`

**Interfaces:**
- Produces: `FrameAnalysis["items"][number]` now has `editions: ItemEdition`-shaped entries and comparables with `note: string` and `editionKey: string | null`.

- [ ] **Step 1: Write the failing prompt tests**

Append to `worker/mode.test.ts`:

```ts
describe("source and edition rules", () => {
  it("asks both modes for annotated sources and separate edition pricing", () => {
    for (const instructions of [BUY_INSTRUCTIONS, SELL_INSTRUCTIONS]) {
      expect(instructions).toContain("one-line note");
      expect(instructions).toContain("near substitute");
      expect(instructions).toContain("Never blend releases");
      expect(instructions).toContain("reissue");
      expect(instructions).toContain("editionKey");
    }
  });

  it("nulls sell-only edition fields in buy mode and titles each edition in sell mode", () => {
    expect(BUY_INSTRUCTIONS).toContain("on the item and on every edition");
    expect(SELL_INSTRUCTIONS).toContain("its own listingTitle naming the release");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run worker/mode.test.ts`
Expected: FAIL on the two new tests (strings not found).

- [ ] **Step 3: Update the schema**

In `worker/agent.ts`, replace `comparableSchema` with:

```ts
const comparableSchema = z.object({
  title: z.string(),
  url: z.string().nullable(),
  priceCents: z.number().int().nonnegative().nullable(),
  currency: z.string(),
  type: z.enum(["retail", "active", "sold"]),
  note: z.string().describe("One line under 120 characters: what this source is and how it influenced the price."),
  editionKey: z.string().nullable().describe("Key of the edition this source is evidence for; null when it applies generally."),
});

const editionSchema = z.object({
  key: z.string().describe("Stable lowercase slug for this release, e.g. original-1988 or reissue."),
  label: z.string().describe("Human label, e.g. Original 1988 pressing."),
  identificationTips: z.string().describe("What to physically check to tell this release apart from the others."),
  likelihood: z.number().min(0).max(1).describe("Probability that the photographed item is this release."),
  estimatedLowCents: z.number().int().nonnegative().nullable(),
  estimatedHighCents: z.number().int().nonnegative().nullable(),
  retailPriceCents: z.number().int().nonnegative().nullable(),
  listPriceCents: z.number().int().nonnegative().nullable().describe("Sell mode only."),
  minimumOfferCents: z.number().int().nonnegative().nullable().describe("Sell mode only."),
  yardSalePriceCents: z.number().int().nonnegative().nullable().describe("Sell mode only."),
  listingTitle: z.string().nullable().describe("Sell mode only: Marketplace title naming this release."),
});
```

In `detectedItemSchema`, change `comparables: z.array(comparableSchema).max(8),` to:

```ts
  comparables: z.array(comparableSchema).max(12),
  editions: z.array(editionSchema).max(4).describe("Separate releases of this product; empty when it had a single release."),
```

- [ ] **Step 4: Update the prompt**

In `RESEARCH_STEPS`, replace step 7 and step 8 with:

```ts
7. Return integer prices in cents. Use null when evidence is insufficient. Include up to 12 comparables with concise source titles and URLs, preferring sold evidence over active listings whenever it exists. eBay comparables must be type "active" and must carry the listing price the tool returned. Every comparable must be the same product and release as the item; when you rely on a near substitute, say so in its note (for example "Series 10, not an exact match; used as a ceiling"). Give every comparable a one-line note under 120 characters stating what it is and how it influenced the price (for example "Sold Aug 2026, same model, heavy wear; anchors the low end").
8. Estimate a conservative resale range that reflects the visible condition and uncertainty.
   When the product was released more than once (original, reissue, re-release, reproduction, anniversary edition, remaster, or similar), research each release separately and return up to 4 editions. Never blend releases into a single price. Give each edition a stable lowercase key, a label, identification tips describing what to physically check (copyright dates, country of manufacture, maker's marks, serial formats), a likelihood that the photographed item is that release based on visible evidence, and its own prices. Set a comparable's editionKey to the edition it is evidence for, otherwise null. The item's top-level price fields must equal the edition with the highest likelihood. Return an empty editions array when the product had a single release.
```

In `BUY_INSTRUCTIONS`, replace step 9 with:

```
9. Set listPriceCents, minimumOfferCents, yardSalePriceCents, listingTitle, and listingDescription to null, on the item and on every edition.
```

In `SELL_INSTRUCTIONS`, append to step 9 (after the "Use null only when there is no defensible basis for a price." line):

```
   Price every edition the same way, and give each edition its own listingTitle naming the release (for example "Original 1988" or "Reissue").
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run worker/mode.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/agent.ts worker/mode.test.ts
git commit -m "Ask the agent for annotated sources and per-edition pricing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the analyze flow and PATCH route

**Files:**
- Modify: `worker/index.ts`

**Interfaces:**
- Consumes: `replaceEditions`, `syncSelectedEdition`, `selectEdition`, `parseEditionSelection`, `EditionSelectionError` (worker/editions.ts); `hydrateItems`, `insertValuationSources` (worker/items.ts).
- Produces: `PATCH /api/items/:id` with body `{ selectedEditionKey: string | null }` → `200 DetectedItem`, `400 { error }`, `404 { error }`. `POST /api/analyze` response items now include `editions`, `selectedEditionKey`, and annotated comparables.

- [ ] **Step 1: Save editions and annotated sources during analyze**

In `analyzeRequest`, replace the block from `const comparableRows = candidate.comparables.map(` through the end of the `detectedItems.push({ ... });` call with:

```ts
      await insertValuationSources(db, id, candidate.comparables, capturedAt);
      await replaceEditions(db, id, candidate.editions);
      const synced = await syncSelectedEdition(db, id);
      const [hydrated] = await hydrateItems(db, [synced]);
      detectedItems.push({ ...hydrated, duplicate });
```

Remove the now-unused `firstSeenAt` and `seenCount` locals (keep `id`, `duplicate`, and the `knownFingerprints.push`). Remove `valuationSources` from the schema import and `Comparable` from the types import if unused.

- [ ] **Step 2: Add the PATCH route and error mapping**

Add imports:

```ts
import { EditionSelectionError, parseEditionSelection, selectEdition } from "./editions";
```

Insert before the `DELETE /api/items/` route:

```ts
      if (request.method === "PATCH" && url.pathname.startsWith("/api/items/")) {
        const itemId = decodeURIComponent(url.pathname.slice("/api/items/".length));
        if (!itemId || itemId.includes("/")) throw new HttpError(400, "Invalid item id.");
        return Response.json(await updateItemEdition(request, env, itemId));
      }
```

Extend the error status mapping:

```ts
        : error instanceof HistoryQueryError || error instanceof ScanModeError || error instanceof EditionSelectionError ? 400 : 500;
```

Add next to `deleteItem`:

```ts
async function updateItemEdition(request: Request, env: Env, itemId: string): Promise<DetectedItem> {
  const body = await request.json<unknown>().catch(() => {
    throw new HttpError(400, "Request body must be JSON.");
  });
  const db = drizzle(env.DB);
  const row = await selectEdition(db, itemId, parseEditionSelection(body));
  if (!row) throw new HttpError(404, "Find not found.");
  const [item] = await hydrateItems(db, [row]);
  return item;
}
```

- [ ] **Step 3: Type-check and test**

Run: `npx tsc -p tsconfig.worker.json --noEmit && npx vitest run`
Expected: no worker type errors; all tests PASS.

- [ ] **Step 4: Manual check against the local worker**

With `npm run dev` running (it serves the worker; local D1 migrated in Task 2), pick an item id:

```bash
npx wrangler d1 execute yard-sale-gold-db --local --command "select id from items limit 1"
curl -s -X PATCH localhost:5173/api/items/<id> -H 'content-type: application/json' -d '{"selectedEditionKey":"nope"}'
curl -s -X PATCH localhost:5173/api/items/<id> -H 'content-type: application/json' -d '{"selectedEditionKey":null}' | head -c 300
curl -s -X PATCH localhost:5173/api/items/missing -H 'content-type: application/json' -d '{"selectedEditionKey":null}'
curl -s -X PATCH localhost:5173/api/items/<id> -d 'not json'
```

Expected: `{"error":"That edition does not belong to this find."}`; a JSON item with `"editions":[]`; `{"error":"Find not found."}`; `{"error":"Request body must be JSON."}`. (Adjust the port if Vite prints a different one.)

Then scan a photo of a collectible with known reissues (e.g. the skateboard deck photo) in sell mode and confirm the `/api/analyze` response items include non-empty `editions` and comparables with `note`.

- [ ] **Step 5: Commit**

```bash
git add worker/index.ts
git commit -m "Save editions on scan and add PATCH to choose an item's edition

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: "Where these prices come from" section

**Files:**
- Create: `src/market-evidence.ts`
- Test: `src/market-evidence.test.ts`
- Modify: `src/App.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: `activeEditionKey` (src/editions.ts), `DetectedItem`, `Comparable`.
- Produces:
  - `type MarketEvidence = { title: string; url: string | null; priceCents: number | null; currency: string; type: "retail" | "active" | "sold" | "web"; note: string | null }`
  - `splitEvidence(item: DetectedItem): { latest: MarketEvidence[]; earlier: MarketEvidence[] }`

- [ ] **Step 1: Write the failing tests**

Create `src/market-evidence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { splitEvidence } from "./market-evidence";
import type { Comparable, DetectedItem, ItemEdition } from "./types";

const comparable = (title: string, capturedAt: string, editionKey: string | null = null): Comparable => ({
  title, url: `https://example.com/${title}`, priceCents: 100, currency: "USD", type: "sold", note: `${title} note`, editionKey, capturedAt,
});
const edition = (key: string, likelihood: number) => ({ key, likelihood } as ItemEdition);
const item = (overrides: Partial<DetectedItem>) => ({
  currency: "USD", valueSummary: "", comparables: [], editions: [], selectedEditionKey: null, ...overrides,
} as DetectedItem);

const LATEST = "2026-09-29T12:00:00Z";
const EARLIER = "2026-09-20T12:00:00Z";

describe("splitEvidence", () => {
  it("separates the latest scan from earlier scans", () => {
    const result = splitEvidence(item({ comparables: [comparable("a", LATEST), comparable("b", EARLIER), comparable("c", LATEST)] }));
    expect(result.latest.map((entry) => entry.title)).toEqual(["a", "c"]);
    expect(result.earlier.map((entry) => entry.title)).toEqual(["b"]);
    expect(result.latest[0].note).toBe("a note");
  });

  it("shows general sources plus the active edition's, defaulting to the best guess", () => {
    const comparables = [comparable("general", LATEST), comparable("orig", LATEST, "original"), comparable("re", LATEST, "reissue")];
    const editions = [edition("original", 0.7), edition("reissue", 0.3)];
    expect(splitEvidence(item({ comparables, editions })).latest.map((entry) => entry.title)).toEqual(["general", "orig"]);
    expect(splitEvidence(item({ comparables, editions, selectedEditionKey: "reissue" })).latest.map((entry) => entry.title)).toEqual(["general", "re"]);
  });

  it("appends summary links to the latest group without duplicating known URLs", () => {
    const result = splitEvidence(item({
      comparables: [comparable("a", LATEST)],
      valueSummary: "See [Store](https://store.example/x) and [A again](https://example.com/a).",
    }));
    expect(result.latest.map((entry) => [entry.title, entry.type])).toEqual([["a", "sold"], ["Store", "web"]]);
  });

  it("handles legacy items with no notes and no sources", () => {
    expect(splitEvidence(item({}))).toEqual({ latest: [], earlier: [] });
    const legacy = { ...comparable("old", EARLIER), note: null };
    expect(splitEvidence(item({ comparables: [legacy] })).latest[0].note).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/market-evidence.test.ts`
Expected: FAIL — `Failed to resolve import "./market-evidence"`.

- [ ] **Step 3: Implement**

Create `src/market-evidence.ts` (replaces `collectMarketEvidence` in `src/App.tsx:1403-1419`, which you delete):

```ts
import { activeEditionKey } from "./editions";
import type { Comparable, DetectedItem } from "./types";

export type MarketEvidence = Pick<Comparable, "title" | "url" | "priceCents" | "currency" | "note"> & {
  type: Comparable["type"] | "web";
};

const MARKDOWN_LINK = /\[([^\]]+)]\((https?:\/\/[^)]+)\)/g;

export function splitEvidence(item: DetectedItem): { latest: MarketEvidence[]; earlier: MarketEvidence[] } {
  const editionKey = activeEditionKey(item);
  const relevant = item.comparables.filter((comparable) => comparable.editionKey === null || comparable.editionKey === editionKey);
  const latestCapture = item.comparables.reduce((latest, comparable) => (comparable.capturedAt > latest ? comparable.capturedAt : latest), "");
  const toEvidence = ({ title, url, priceCents, currency, type, note }: Comparable): MarketEvidence => ({ title, url, priceCents, currency, type, note });
  const latest = relevant.filter((comparable) => comparable.capturedAt === latestCapture).map(toEvidence);
  const earlier = relevant.filter((comparable) => comparable.capturedAt !== latestCapture).map(toEvidence);

  const knownUrls = new Set(item.comparables.map((comparable) => comparable.url).filter(Boolean));
  for (const [, title, url] of item.valueSummary.matchAll(MARKDOWN_LINK)) {
    if (!url || knownUrls.has(url)) continue;
    latest.push({ title: title || "Web result", url, priceCents: null, currency: item.currency, type: "web", note: null });
    knownUrls.add(url);
  }
  return { latest, earlier };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/market-evidence.test.ts`
Expected: PASS.

- [ ] **Step 5: Render the section in `ItemDetail`**

In `src/App.tsx`:

1. `import { splitEvidence, type MarketEvidence } from "./market-evidence";`
2. In `ItemDetail`, replace `const marketEvidence = collectMarketEvidence(item);` with:

```tsx
  const evidence = splitEvidence(item);
  const [showEarlierSources, setShowEarlierSources] = useState(false);
```

3. In the detail JSX, remove `<p>{item.valueSummary}</p>` from `.detail-values`, remove the old `{marketEvidence.length > 0 && (<section className="comparables">…</section>)}` block, and insert directly after the closing `</div>` of `.detail-values` (i.e. before the Lens `<a>`):

```tsx
              <section className="comparables">
                <h3>Where these prices come from</h3>
                {item.valueSummary && <p className="comparables-summary">{item.valueSummary}</p>}
                {evidence.latest.map((entry, index) => <EvidenceRow key={`latest-${entry.title}-${index}`} entry={entry} />)}
                {evidence.earlier.length > 0 && (
                  <button type="button" className="earlier-sources-toggle" data-export-exclude onClick={() => setShowEarlierSources((open) => !open)}>
                    {showEarlierSources ? "Hide" : "Show"} {evidence.earlier.length} source{evidence.earlier.length === 1 ? "" : "s"} from earlier scans
                  </button>
                )}
                {showEarlierSources && evidence.earlier.map((entry, index) => <EvidenceRow key={`earlier-${entry.title}-${index}`} entry={entry} />)}
              </section>
```

4. Add below `ItemDetail`:

```tsx
function EvidenceRow({ entry }: { entry: MarketEvidence }) {
  const content = (
    <>
      <span className={`comp-type ${entry.type}`}>{entry.type}</span>
      <span className="comp-title">{entry.title}</span>
      <strong>{entry.priceCents === null ? "—" : money(entry.priceCents, entry.currency)}</strong>
      {entry.url ? <ExternalLink size={15} /> : <span />}
      {entry.note && <small className="comp-note">{entry.note}</small>}
    </>
  );
  return entry.url ? <a href={entry.url} target="_blank" rel="noreferrer">{content}</a> : <div>{content}</div>;
}
```

- [ ] **Step 6: Styles**

In `src/styles.css`, after the `.comparables a:hover` rule, add:

```css
.comparables-summary { margin: 4px 0 10px; color: var(--muted); font-size: 12px; line-height: 1.4; }
.comp-title { min-width: 0; overflow-wrap: anywhere; }
.comp-note { grid-column: 2 / -1; margin-top: -4px; color: var(--muted); font-size: 11px; line-height: 1.35; }
.earlier-sources-toggle { width: 100%; min-height: 40px; padding: 8px 0; color: var(--green); background: none; border: 0; border-top: 1px solid rgba(23,23,19,.12); font-size: 12px; font-weight: 700; text-align: left; cursor: pointer; }
```

- [ ] **Step 7: Verify in the browser**

Run `npx tsc -b --noEmit` — expected: no errors. Open an existing find in history at the dev URL: the section sits directly under the prices, shows the summary, rows with no notes look like before, and older items scanned several times show the "earlier scans" toggle. Open a find scanned after Task 6: rows show notes in a muted second line.

- [ ] **Step 8: Commit**

```bash
git add src/market-evidence.ts src/market-evidence.test.ts src/App.tsx src/styles.css
git commit -m "Show annotated price sources next to prices, latest scan first

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Edition picker, PATCH wiring, and card badge

**Files:**
- Modify: `src/App.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: `activeEditionKey`, `withEditionSelection` (src/editions.ts); `PATCH /api/items/:id` (Task 6).
- Produces: `EditionPicker` component; `selectEditionRequest(itemId: string, selectedEditionKey: string | null): Promise<DetectedItem>`.

- [ ] **Step 1: API helper**

Add after `deleteAllFindsRequest` in `src/App.tsx`:

```ts
async function selectEditionRequest(itemId: string, selectedEditionKey: string | null): Promise<DetectedItem> {
  const response = await fetch(`/api/items/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selectedEditionKey }),
  });
  if (!response.ok) throw new Error("Could not save the edition.");
  return response.json();
}
```

Add imports: `import { activeEditionKey, withEditionSelection } from "./editions";` and add `InfiniteData` to the `@tanstack/react-query` import (`import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";`).

- [ ] **Step 2: Optimistic update in `App`**

Inside `App`, after `refreshHistory`, add:

```ts
  // Items live in several places (live feed, history pages, frame lists, the open detail); update them all.
  const applyItemUpdate = useCallback((updated: DetectedItem) => {
    const swap = (candidate: DetectedItem) => (candidate.id === updated.id ? updated : candidate);
    setSelectedItem((current) => (current ? swap(current) : current));
    setSelectedFrameItems((current) => current.map(swap));
    setLiveItems((current) => current.map(swap));
    queryClient.setQueriesData<DetectedItem[]>({ queryKey: ["frame-items"] }, (current) => current?.map(swap));
    queryClient.setQueriesData<InfiniteData<HistoryPage>>({ queryKey: ["items"] }, (current) =>
      current && { ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.map(swap) })) },
    );
  }, [queryClient]);

  const changeEdition = useCallback(async (item: DetectedItem, selectedEditionKey: string | null) => {
    applyItemUpdate(withEditionSelection(item, selectedEditionKey));
    try {
      applyItemUpdate(await selectEditionRequest(item.id, selectedEditionKey));
    } catch (editionError) {
      applyItemUpdate(item);
      throw editionError;
    }
  }, [applyItemUpdate]);
```

Pass it to `ItemDetail`: add the prop `onChangeEdition={(key) => changeEdition(selectedItem, key)}` to the `<ItemDetail … />` element, and add `onChangeEdition: (selectedEditionKey: string | null) => Promise<void>;` to `ItemDetail`'s props type (and destructure it).

- [ ] **Step 3: `EditionPicker` component**

Change `formatRange` to accept only the fields it reads:

```ts
function formatRange(item: Pick<DetectedItem, "estimatedLowCents" | "estimatedHighCents" | "currency">): string {
```

Add below `SellerPricing`:

```tsx
function EditionPicker({ item, onChange }: { item: DetectedItem; onChange: (selectedEditionKey: string | null) => Promise<void> }) {
  const [tipsKey, setTipsKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeKey = activeEditionKey(item);
  const bestKey = item.editions[0]?.key;

  const choose = async (key: string) => {
    if (key === activeKey || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onChange(key);
    } catch (editionError) {
      setError(editionError instanceof Error ? editionError.message : "Could not save the edition.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="edition-picker" aria-label="Edition">
      <h3>Which edition do you have?</h3>
      {item.editions.map((edition) => (
        <div key={edition.key} className={`edition-option${edition.key === activeKey ? " active" : ""}`}>
          <button type="button" className="edition-choose" onClick={() => void choose(edition.key)} aria-pressed={edition.key === activeKey} disabled={saving}>
            <span className="edition-label">{edition.label}</span>
            <span className="edition-likelihood">
              {edition.key === bestKey ? "Best guess · " : ""}{Math.round(edition.likelihood * 100)}%
            </span>
            <strong>
              {item.mode === "sell"
                ? `${optionalMoney(edition.listPriceCents, item.currency)} Marketplace`
                : formatRange({ ...edition, currency: item.currency })}
            </strong>
          </button>
          {edition.identificationTips && (
            <button type="button" className="edition-tips-toggle" data-export-exclude onClick={() => setTipsKey(tipsKey === edition.key ? null : edition.key)} aria-expanded={tipsKey === edition.key}>
              How to tell
            </button>
          )}
          {tipsKey === edition.key && <p className="edition-tips">{edition.identificationTips}</p>}
        </div>
      ))}
      {error && <p className="edition-error" role="alert">{error}</p>}
    </section>
  );
}
```

In `ItemDetail`, render it between `<p className="detail-description">…</p>` and `{item.mode === "sell" && <SellerPricing item={item} />}`:

```tsx
              {item.editions.length > 0 && <EditionPicker key={item.id} item={item} onChange={onChangeEdition} />}
```

- [ ] **Step 4: Card badge**

In `ItemCard`, after the `sell-badge` line:

```tsx
          {item.editions.length > 1 && <span className="edition-badge">{item.editions.length} editions</span>}
```

- [ ] **Step 5: Styles**

In `src/styles.css`, add `.edition-badge,` and `.edition-option,` to the `:where(...) { corner-shape: squircle; }` list, add after `.sell-badge`:

```css
.edition-badge { flex: 0 0 auto; padding: 2px 5px; color: var(--ink); background: var(--gold); border-radius: 4px; }
```

and after the `.listing-draft p` rule:

```css
.edition-picker { display: grid; gap: 8px; margin: 18px 0 4px; color: var(--ink); }
.edition-picker h3 { margin: 0; color: var(--muted); font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.edition-option { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 0 8px; padding: 10px 12px; background: white; border: 2px solid rgba(23,23,19,.12); border-radius: 12px; }
.edition-option.active { border-color: var(--green); }
.edition-choose { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; padding: 0; text-align: left; background: none; border: 0; cursor: pointer; }
.edition-choose:disabled { cursor: progress; }
.edition-label { font: 700 14px/1.2 "Space Grotesk",sans-serif; }
.edition-likelihood { color: var(--muted); font-size: 11px; font-weight: 600; }
.edition-choose strong { grid-column: 1 / -1; color: var(--green); font-size: 16px; }
.edition-tips-toggle { align-self: start; padding: 4px 8px; color: var(--green); background: none; border: 1px solid currentColor; border-radius: 8px; font-size: 11px; font-weight: 700; cursor: pointer; }
.edition-tips { grid-column: 1 / -1; margin: 8px 0 0; color: #3b3b35; font-size: 12px; line-height: 1.45; }
.edition-error { margin: 0; color: #9b2c1f; font-size: 12px; }
```

- [ ] **Step 6: Verify**

Run: `npx tsc -b --noEmit && npx vitest run`
Expected: no type errors; all tests PASS.

In the browser at phone width (390px) and desktop:
1. Open the find scanned in Task 6 with editions. The picker shows editions ordered by likelihood with "Best guess" on the first; it is highlighted.
2. Tap the other edition: Marketplace/lowest/yard-sale prices, listing title, and the sources list switch immediately; reload the page — the choice persists.
3. Go back to history: the card shows the chosen edition's price and an "N editions" badge.
4. In DevTools, set the network to Offline and tap the other edition: prices flip, then flip back, and "Could not save the edition." appears.
5. Open a buy-mode find with editions (scan the deck photo in buy mode): editions show resale ranges instead of Marketplace prices.
6. Open an old item with no editions: no picker, detail view otherwise unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/styles.css
git commit -m "Add edition picker with optimistic selection and an editions badge on cards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Release check (requires user confirmation before remote steps)

**Files:** none

- [ ] **Step 1: Baseline latency**

Before deploying, record current scan latency for sell-mode collectibles:

```bash
npx wrangler d1 execute yard-sale-gold-db --remote --json --command "select captured_at, latency_ms, searches_performed from frame_runs where status='completed' order by captured_at desc limit 20"
```

- [ ] **Step 2: Ask the user before migrating and deploying production**

Confirm with the user, then run `npm run db:migrate:remote` followed by `npm run deploy`. (`wrangler.jsonc` is skip-worktree for the fork deployment — do not modify or commit it.)

- [ ] **Step 3: Rescan the deck on the deployed app and compare**

Have the user rescan the Frankie Hill Bulldog deck in sell mode, then re-run the Step 1 query and compare the newest `latency_ms` and `searches_performed` to the baseline. Report the numbers to the user.
