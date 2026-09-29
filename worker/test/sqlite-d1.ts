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
        raw: async () => {
          // Positional arrays like real D1; object rows would collapse duplicate column names in joins.
          const prepared = statement();
          prepared.setReturnArrays(true);
          return prepared.all(...params);
        },
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
