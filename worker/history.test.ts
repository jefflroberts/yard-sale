import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { HISTORY_PAGE_SIZE, historyQuery } from "./history";

// Execute the production query against SQLite, including the real migrations.
const queryDb = drizzle({} as D1Database);
let sqlite: DatabaseSync;
function page(params = new URLSearchParams()) {
  const query = historyQuery(queryDb, params).toSQL();
  return sqlite.prepare(query.sql).all(...query.params as string[]);
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  const migrations = new NodeURL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new NodeURL(file, migrations), "utf8"));
  }
  sqlite.exec("INSERT INTO scan_sessions (id, source_type, started_at) VALUES ('session', 'image', '2026-09-16T12:00:00Z')");
  const insert = sqlite.prepare(`INSERT INTO items
    (id, scan_session_id, fingerprint, name, category, description, condition, confidence,
     value_summary, thumbnail_key, raw_json, first_seen_at, last_seen_at)
    VALUES (?, 'session', ?, ?, 'Electronics', 'A useful find', 'Used', 1, '', 'frame.jpg', '{}', ?, ?)`);
  for (let index = 0; index < 135; index++) {
    const id = String(index).padStart(3, "0");
    const date = index < 10 ? "2026-09-15T12:00:00Z" : "2026-09-16T12:00:00Z";
    insert.run(id, id, index === 0 ? "Rare Walkman" : `Find ${id}`, date, date);
  }
});
afterEach(() => sqlite.close());

describe("history retrieval", () => {
  it("reaches all entries beyond the former 100 cap, including timestamp ties", () => {
    const ids: unknown[] = [];
    const params = new URLSearchParams();
    for (;;) {
      const rows = page(params);
      expect(rows.length).toBeLessThanOrEqual(HISTORY_PAGE_SIZE + 1);
      const visible = rows.slice(0, HISTORY_PAGE_SIZE);
      ids.push(...visible.map((row) => row.id));
      if (rows.length <= HISTORY_PAGE_SIZE) break;
      const last = visible.at(-1)!;
      params.set("cursor", JSON.stringify({ id: last.id, lastSeenAt: last.last_seen_at }));
    }
    expect(ids).toHaveLength(135);
    expect(new Set(ids).size).toBe(135);
    expect(ids.at(-1)).toBe("000");
  });

  it("searches older records and matches words across metadata fields", () => {
    const rows = page(new URLSearchParams({ q: "  WALKMAN electronics used  " }));
    expect(rows.map((row) => row.id)).toEqual(["000"]);
    sqlite.exec("UPDATE items SET brand = 'Sony', model = 'WM-2', value_summary = 'Collectible' WHERE id = '000'");
    expect(page(new URLSearchParams({ q: "sony wm-2 collectible" })).map((row) => row.id)).toEqual(["000"]);
  });

  it("treats SQL wildcards and injection text literally", () => {
    expect(page(new URLSearchParams({ q: "%" }))).toEqual([]);
    expect(page(new URLSearchParams({ q: "_' OR 1=1 --" }))).toEqual([]);
    expect(page(new URLSearchParams({ q: "missing" }))).toEqual([]);
  });

  it("continues after deletion of the cursor item", () => {
    const last = page()[HISTORY_PAGE_SIZE - 1];
    const params = new URLSearchParams({ cursor: JSON.stringify({ id: last.id, lastSeenAt: last.last_seen_at }) });
    sqlite.prepare("DELETE FROM items WHERE id = ?").run(last.id);
    const next = page(params);
    expect(next[0].id).toBe("034");
  });

  it("rejects invalid cursors and oversized searches", () => {
    for (const cursor of ["", "nope", "null", "{}", '{"id":1,"lastSeenAt":"x"}']) {
      expect(() => page(new URLSearchParams({ cursor }))).toThrow("Invalid history cursor");
    }
    expect(() => page(new URLSearchParams({ q: "x".repeat(501) }))).toThrow("500 characters");
  });

  it("filters by scan mode and treats existing finds as buy mode", () => {
    sqlite.exec("UPDATE items SET mode = 'sell' WHERE id IN ('001', '002')");
    expect(page(new URLSearchParams({ mode: "sell" })).map((row) => row.id)).toEqual(["002", "001"]);
    expect(page(new URLSearchParams({ mode: "buy" }))).toHaveLength(HISTORY_PAGE_SIZE + 1);
    expect(page(new URLSearchParams({ mode: "sell", q: "find 001" })).map((row) => row.id)).toEqual(["001"]);
    expect(() => page(new URLSearchParams({ mode: "trade" }))).toThrow("Invalid scan mode");
  });

  it("keeps buy and sell finds with the same fingerprint separate", () => {
    const insertSell = (id: string) => sqlite.prepare(`INSERT INTO items
      (id, scan_session_id, fingerprint, name, category, description, condition, confidence,
       value_summary, thumbnail_key, raw_json, first_seen_at, last_seen_at, mode)
      VALUES (?, 'session', '000', 'My Walkman', 'Electronics', '', 'Used', 1, '', 'frame.jpg', '{}',
        '2026-09-17T12:00:00Z', '2026-09-17T12:00:00Z', 'sell')`).run(id);
    insertSell("mine");
    expect(() => insertSell("again")).toThrow("UNIQUE");
  });
});
