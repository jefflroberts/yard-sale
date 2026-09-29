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
