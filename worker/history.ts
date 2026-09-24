import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { items } from "./db/schema";
import { parseScanMode, ScanModeError } from "./mode";

export const HISTORY_PAGE_SIZE = 100;

export class HistoryQueryError extends Error {}

export function historyQuery(db: ReturnType<typeof drizzle>, params: URLSearchParams) {
  const search = (params.get("q") ?? "").trim();
  if (search.length > 500) throw new HistoryQueryError("Search must be 500 characters or fewer.");
  const modeValue = params.get("mode");
  let mode;
  try {
    mode = modeValue === null ? null : parseScanMode(modeValue);
  } catch (error) {
    if (error instanceof ScanModeError) throw new HistoryQueryError(error.message);
    throw error;
  }
  const cursorValue = params.get("cursor");
  let cursor: { lastSeenAt: string; id: string } | undefined;
  if (cursorValue !== null) {
    try {
      const parsed = JSON.parse(cursorValue);
      if (!parsed || typeof parsed.lastSeenAt !== "string" || typeof parsed.id !== "string" || !parsed.id) {
        throw new Error();
      }
      cursor = parsed;
    } catch {
      throw new HistoryQueryError("Invalid history cursor.");
    }
  }

  // Each word can match a different field. instr treats %, _ and quotes literally.
  const searchableText = sql`lower(
    ${items.name} || ' ' || ${items.category} || ' ' || coalesce(${items.brand}, '') || ' ' ||
    coalesce(${items.model}, '') || ' ' || ${items.description} || ' ' || ${items.condition} || ' ' ||
    ${items.valueSummary} || ' ' || ${items.fingerprint} || ' ' || ${items.currency} || ' ' ||
    ${items.firstSeenAt} || ' ' || ${items.lastSeenAt}
  )`;
  return db.select().from(items).where(and(
    mode ? eq(items.mode, mode) : undefined,
    ...search.split(/\s+/).filter(Boolean).map((term) => sql`instr(${searchableText}, lower(${term})) > 0`),
    cursor ? or(
      lt(items.lastSeenAt, cursor.lastSeenAt),
      and(eq(items.lastSeenAt, cursor.lastSeenAt), lt(items.id, cursor.id)),
    ) : undefined,
  )).orderBy(desc(items.lastSeenAt), desc(items.id)).limit(HISTORY_PAGE_SIZE + 1);
}
