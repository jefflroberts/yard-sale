# Price Sources and Editions — Design

Date: 2026-09-29
Status: Approved in conversation, pending spec review

## Goal

Make every price the app shows traceable to its evidence, and stop blending
originals with reissues. When pricing an item (sell mode) or evaluating a find
(buy mode), the user can see which sources produced the numbers and why, and
for items that exist in multiple releases (original, reissue, re-release,
reproduction, anniversary edition, and similar), see separate pricing per
edition and pick the one they actually have.

## Evidence from production (2026-09-29)

Three most recent sell-mode items in D1:

- **Google Home** — 2 sources; the "sold" one is a Nest Mini (different product) with no price.
- **Frankie Hill Bulldog deck** — $65 retail (likely reissue) and $561 sold (likely 1988 original)
  both found; summary says it "cannot tell original vs reissue, so pricing is conservative."
- **Apple Watch** — active eBay sources for Series 10/11 with no prices.

Sources already have URLs and render under "Sold comps & web results", but they
are sparse, often unpriced, sometimes the wrong product, carry no explanation,
and sit below the fold. `search_ebay_active_listings` does return prices; the
model is dropping them.

## Scope

- Applies to both buy and sell mode.
- Existing items are not backfilled; they simply have no editions and no source notes.

## 1. Agent output and prompt (`worker/agent.ts`)

### Comparable schema

Add to `comparableSchema`:

- `note: string` — required, one line, under ~120 characters: what the source is and how it
  influenced the price (e.g. "Sold Aug 2026, same model, heavy wear — anchors low end").
- `editionKey: string | null` — which edition this source is evidence for; null = applies generally.

Raise `comparables` max from 8 to 12.

### Editions

Add `editions` to `detectedItemSchema`, max 4, empty array for ordinary items. Each edition:

| Field | Type | Notes |
|---|---|---|
| `key` | string | Stable lowercase slug, e.g. `original-1988`, `reissue` |
| `label` | string | Human label, e.g. "Original 1988 pressing" |
| `identificationTips` | string | What to physically check to tell editions apart |
| `likelihood` | number 0–1 | Agent's belief the photographed item is this edition |
| `estimatedLowCents`, `estimatedHighCents`, `retailPriceCents` | int \| null | Both modes |
| `listPriceCents`, `minimumOfferCents`, `yardSalePriceCents` | int \| null | Sell mode; null in buy mode |
| `listingTitle` | string \| null | Sell mode; edition-specific title. Null in buy mode |

The item's existing top-level price fields continue to hold the most-likely
edition's values. `listingDescription` stays shared across editions.

### Prompt rules (added to `RESEARCH_STEPS`, both modes)

1. Every comparable must be the same product and edition, or its note must say it is the
   nearest substitute (e.g. "Series 10, not exact — used as ceiling").
2. Always fill `priceCents` on active eBay comparables when the tool returns one. Include and
   prefer sold evidence when it exists.
3. When a product exists in multiple releases (original, reissue, re-release, reproduction,
   anniversary edition, etc.), research each separately, populate `editions`, tag comparables
   with `editionKey`, and do not blend editions into one price. Top-level prices = the edition
   with the highest likelihood.

Buy mode's step 9 also sets edition sell-only fields to null.

### Risk

Extra per-edition research adds latency on collectibles. Verify by comparing the
deck's scan latency in `frame_runs` before and after.

## 2. Storage and API

### Migration 0005 (drizzle-kit generated)

- New table `item_editions`:
  - `id` text PK
  - `item_id` text FK → `items.id`, `ON DELETE CASCADE`
  - `key`, `label`, `identification_tips` text; `likelihood` real
  - `estimated_low_cents`, `estimated_high_cents`, `retail_price_cents`, `list_price_cents`,
    `minimum_offer_cents`, `yard_sale_price_cents` integer nullable
  - `listing_title` text nullable
  - unique index on (`item_id`, `key`)
- `valuation_sources`: add nullable `note` text, nullable `edition_key` text.
- `items`: add nullable `selected_edition_key` text. Null = use the agent's most likely edition.

Editions are referenced by **key**, not row id, because editions are replaced on every rescan.

### Upsert behavior (`worker/index.ts` analyze flow)

- After the item upsert, delete the item's `item_editions` rows and insert the new scan's editions.
- If `selected_edition_key` is set and the new editions still contain that key, overwrite the
  item's top-level price columns (and `listing_title`) from that edition. If the key is gone,
  set `selected_edition_key` to null and keep the agent's top-level values.
- Sources keep accumulating per scan (existing behavior), now with `note` and `edition_key`.

### API

- `GET /api/items`, `GET /api/items/:id`: each item includes `editions[]` (ordered by likelihood
  desc) and `selectedEditionKey`; each comparable includes `note`, `editionKey`, and `capturedAt`.
- New `PATCH /api/items/:id`, body `{ selectedEditionKey: string | null }`:
  - 404 if item missing; 400 if key not among the item's editions.
  - With a key: copy that edition's price fields and listing title into the item's top-level
    columns and store the key.
  - With null: restore the highest-likelihood edition's values and clear the key.
  - Returns the updated item.

### Tests

Following `worker/history.test.ts` patterns:

- Rescan replaces editions; selection survives when key persists, clears when it doesn't.
- PATCH validation (unknown key → 400, missing item → 404) and price copying, including null reset.
- Serialization of `note`, `editionKey`, `capturedAt`, `editions`, `selectedEditionKey`.

## 3. UI (`src/App.tsx`, `src/types.ts`, `src/styles.css`)

### Detail view order (both modes)

1. Name, description
2. **Edition picker** (only when `editions.length > 0`): one card per edition with label,
   likelihood ("Best guess" on the highest), headline price (Marketplace price in sell mode,
   resale range in buy mode), and an expandable "How to tell" with identification tips.
   Selected edition is highlighted; when `selectedEditionKey` is null the best guess is shown as
   selected. Tapping sends the PATCH with an optimistic update (TanStack Query), rolling back on error.
3. Pricing: `SellerPricing` in sell mode; resale/retail boxes in both modes — reflecting the
   selected edition.
4. **"Where these prices come from"** (replaces "Sold comps & web results", moved up from below
   the Lens link):
   - `valueSummary` text.
   - Sources from the latest scan (max `capturedAt`) whose `editionKey` is null or matches the
     selected edition. Each row: type badge, title, price, external link, and the note as a
     muted second line. Rows without notes render as today.
   - Markdown links extracted from `valueSummary` (existing `web` type) still included.
   - "Show N sources from earlier scans" toggle reveals older rows under the same edition filter.
5. Google Lens link
6. Brand / Model / Condition / Seen facts

### Item cards

Add an "N editions" badge beside the category/"Selling" badges when the item has editions.
Card prices already read top-level columns and follow the selection automatically.

### Unchanged

Frame overlay item list; history filters.

## Out of scope

- Backfilling editions or notes for existing items.
- Per-edition listing descriptions.
- Deduplicating sources across scans (handled in the UI by showing latest scan first).
