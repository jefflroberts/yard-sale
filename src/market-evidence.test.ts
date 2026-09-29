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
