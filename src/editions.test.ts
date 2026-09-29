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
