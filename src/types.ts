export type ScanMode = "buy" | "sell";

export type Stats = {
  framesProcessed: number;
  itemsIdentified: number;
  searchesPerformed: number;
  modelCalls: number;
  lastUpdated: string | null;
};

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

export type BoundingBox = {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
};

export type DetectedItem = {
  id: string;
  scanSessionId: string;
  fingerprint: string;
  name: string;
  category: string;
  brand: string | null;
  model: string | null;
  description: string;
  condition: string;
  confidence: number;
  observedPriceCents: number | null;
  currency: string;
  estimatedLowCents: number | null;
  estimatedHighCents: number | null;
  retailPriceCents: number | null;
  activePriceCents: number | null;
  soldPriceCents: number | null;
  mode: ScanMode;
  listPriceCents: number | null;
  minimumOfferCents: number | null;
  yardSalePriceCents: number | null;
  listingTitle: string | null;
  listingDescription: string | null;
  valueSummary: string;
  thumbnailUrl: string;
  boundingBox: BoundingBox | null;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  duplicate: boolean;
  comparables: Comparable[];
  editions: ItemEdition[];
  selectedEditionKey: string | null;
};

export type HistoryPage = {
  items: DetectedItem[];
  nextCursor: string | null;
};

export type AnalysisResponse = {
  frameId: string;
  items: DetectedItem[];
  stats: Stats;
  run: {
    latencyMs: number;
    modelCalls: number;
    searchesPerformed: number;
  };
};

export type AgentRunEvent = {
  sequence: number;
  type: string;
  title: string;
  data: unknown;
};

export type AgentRunHistory = {
  frameId: string;
  scanSessionId: string;
  thumbnailUrl: string;
  capturedAt: string;
  completedAt: string | null;
  latencyMs: number;
  itemCount: number;
  modelCalls: number;
  searchesPerformed: number;
  model: string;
  status: "completed" | "failed";
  error: string | null;
  instructions: string;
  input: unknown;
  events: AgentRunEvent[];
  rawResponses: unknown[];
  output: unknown;
  usage: unknown;
};
