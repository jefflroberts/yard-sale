import { Buffer } from "node:buffer";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { AgentRunEvent, AgentRunHistory, AnalysisResponse, DetectedItem, HistoryPage, Stats } from "../src/types";
import { HISTORY_PAGE_SIZE, HistoryQueryError, historyQuery } from "./history";
import { agentInstructions, analyzeFrame, buildAgentInputText } from "./agent";
import { appStats, frameRuns, items, scanSessions } from "./db/schema";
import { EditionSelectionError, normalizeCandidateEditions, parseEditionSelection, replaceEditions, selectEdition, syncSelectedEdition } from "./editions";
import { hydrateItems, insertValuationSources } from "./items";
import { parseScanMode, ScanModeError } from "./mode";
import { fingerprintSimilarity, normalizeFingerprint } from "./normalize";

const MAX_FRAME_BYTES = 2_500_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return Response.json({ ok: true, model: env.OPENAI_MODEL });
      }

      if (request.method === "GET" && url.pathname === "/api/stats") {
        return Response.json(await getStats(env));
      }

      if (request.method === "GET" && url.pathname === "/api/items") {
        return Response.json(await getItems(env, url.searchParams));
      }

      if (request.method === "DELETE" && url.pathname === "/api/items") {
        return Response.json(await deleteAllItems(env));
      }

      if (request.method === "PATCH" && url.pathname.startsWith("/api/items/")) {
        const itemId = decodeURIComponent(url.pathname.slice("/api/items/".length));
        if (!itemId || itemId.includes("/")) throw new HttpError(400, "Invalid item id.");
        return Response.json(await updateItemEdition(request, env, itemId));
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/items/")) {
        const itemId = decodeURIComponent(url.pathname.slice("/api/items/".length));
        if (!itemId || itemId.includes("/")) throw new HttpError(400, "Invalid item id.");
        return Response.json(await deleteItem(env, itemId));
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/agent-runs/by-item/")) {
        const itemId = decodeURIComponent(url.pathname.slice("/api/agent-runs/by-item/".length));
        if (!itemId || itemId.includes("/")) throw new HttpError(400, "Invalid item id.");
        return Response.json(await getAgentRunForItem(env, itemId));
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/items/")) {
        const itemId = decodeURIComponent(url.pathname.slice("/api/items/".length));
        if (!itemId || itemId.includes("/")) throw new HttpError(400, "Invalid item id.");
        return Response.json(await getFrameItems(env, itemId));
      }

      if (request.method === "POST" && url.pathname === "/api/sessions") {
        return await createSession(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/analyze") {
        return await analyzeRequest(request, env);
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/thumbnails/")) {
        return await serveThumbnail(url, env);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      const status = error instanceof HttpError
        ? error.status
        : error instanceof HistoryQueryError || error instanceof ScanModeError || error instanceof EditionSelectionError ? 400 : 500;
      const message = error instanceof Error ? error.message : "Unexpected error";
      console.error(JSON.stringify({ message: "request failed", path: url.pathname, status, error: message }));
      return Response.json({ error: message }, { status });
    }
  },
} satisfies ExportedHandler<Env>;

async function createSession(request: Request, env: Env): Promise<Response> {
  const body = await request.json<unknown>();
  if (!isRecord(body) || typeof body.id !== "string") {
    throw new HttpError(400, "A session id is required.");
  }

  const sourceType = body.sourceType === "video" || body.sourceType === "image" ? body.sourceType : "camera";
  const sourceName = typeof body.sourceName === "string" ? body.sourceName.slice(0, 240) : null;
  const startedAt = new Date().toISOString();
  const db = drizzle(env.DB);

  await db
    .insert(scanSessions)
    .values({ id: body.id, sourceType, sourceName, startedAt })
    .onConflictDoNothing();

  return Response.json({ id: body.id, sourceType, sourceName, startedAt }, { status: 201 });
}

async function analyzeRequest(request: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY === "your_openai_api_key_here") {
    throw new HttpError(503, "Add your OpenAI API key to .dev.vars before scanning.");
  }

  const started = Date.now();
  const form = await request.formData();
  const image = form.get("image");
  const sessionId = form.get("sessionId");
  const capturedAtValue = form.get("capturedAt");
  const findCriteriaValue = form.get("findCriteria");
  const mode = parseScanMode(form.get("mode"));

  if (!(image instanceof File) || !image.type.startsWith("image/")) {
    throw new HttpError(400, "A JPEG or WebP frame is required.");
  }
  if (image.size > MAX_FRAME_BYTES) {
    throw new HttpError(413, "Frame exceeds the 2.5 MB limit.");
  }
  if (typeof sessionId !== "string" || !sessionId) {
    throw new HttpError(400, "A session id is required.");
  }
  if (findCriteriaValue !== null && typeof findCriteriaValue !== "string") {
    throw new HttpError(400, "Find criteria must be text.");
  }
  const findCriteria = (findCriteriaValue ?? "").slice(0, 1000);

  const capturedAt =
    typeof capturedAtValue === "string" && !Number.isNaN(Date.parse(capturedAtValue))
      ? new Date(capturedAtValue).toISOString()
      : new Date().toISOString();
  const frameId = crypto.randomUUID();
  const extension = image.type === "image/webp" ? "webp" : "jpg";
  const thumbnailKey = `frames/${sessionId}/${frameId}.${extension}`;
  const bytes = await image.arrayBuffer();
  const imageDataUrl = `data:${image.type};base64,${Buffer.from(bytes).toString("base64")}`;
  const db = drizzle(env.DB);

  await db
    .insert(scanSessions)
    .values({ id: sessionId, sourceType: "camera", sourceName: null, startedAt: capturedAt })
    .onConflictDoNothing();
  await env.THUMBNAILS.put(thumbnailKey, bytes, {
    httpMetadata: { contentType: image.type, cacheControl: "private, max-age=31536000, immutable" },
  });

  try {
    const result = await analyzeFrame({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      imageDataUrl,
      db,
      sessionId,
      findCriteria,
      mode,
      ebayCredentials:
        env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET
          ? { clientId: env.EBAY_CLIENT_ID, clientSecret: env.EBAY_CLIENT_SECRET }
          : undefined,
    });
    const detectedItems: DetectedItem[] = [];
    const knownFingerprints = await db
      .select({ id: items.id, fingerprint: items.fingerprint })
      .from(items)
      .where(eq(items.mode, mode))
      .orderBy(desc(items.lastSeenAt))
      .limit(250);

    for (const rawCandidate of result.analysis.items) {
      const candidate = normalizeCandidateEditions(rawCandidate);
      const proposedFingerprint = normalizeFingerprint(candidate.fingerprint || candidate.name);
      if (!proposedFingerprint) continue;

      const lunaMatch = candidate.previousMatchId
        ? knownFingerprints.find((known) => known.id === candidate.previousMatchId)
        : undefined;
      const fingerprintFallback = knownFingerprints
        .map((known) => ({ ...known, score: fingerprintSimilarity(proposedFingerprint, known.fingerprint) }))
        .filter((known) => known.score >= 0.72)
        .sort((left, right) => right.score - left.score)[0];
      const previousMatch = lunaMatch ?? fingerprintFallback;
      const fingerprint = previousMatch?.fingerprint ?? proposedFingerprint;

      const proposedId = crypto.randomUUID();
      const [saved] = await db
        .insert(items)
        .values({
          id: proposedId,
          scanSessionId: sessionId,
          fingerprint,
          name: candidate.name,
          category: candidate.category,
          brand: candidate.brand,
          model: candidate.model,
          description: candidate.description,
          condition: candidate.condition,
          confidence: candidate.confidence,
          observedPriceCents: candidate.observedPriceCents,
          currency: candidate.currency,
          estimatedLowCents: candidate.estimatedLowCents,
          estimatedHighCents: candidate.estimatedHighCents,
          retailPriceCents: candidate.retailPriceCents,
          activePriceCents: candidate.activePriceCents,
          soldPriceCents: candidate.soldPriceCents,
          mode,
          listPriceCents: candidate.listPriceCents,
          minimumOfferCents: candidate.minimumOfferCents,
          yardSalePriceCents: candidate.yardSalePriceCents,
          listingTitle: candidate.listingTitle,
          listingDescription: candidate.listingDescription,
          valueSummary: candidate.valueSummary,
          thumbnailKey,
          boxXMin: candidate.boundingBox.xMin,
          boxYMin: candidate.boundingBox.yMin,
          boxXMax: candidate.boundingBox.xMax,
          boxYMax: candidate.boundingBox.yMax,
          rawJson: JSON.stringify(candidate),
          firstSeenAt: capturedAt,
          lastSeenAt: capturedAt,
          seenCount: 1,
        })
        .onConflictDoUpdate({
          target: [items.mode, items.fingerprint],
          set: {
            name: candidate.name,
            category: candidate.category,
            brand: candidate.brand,
            model: candidate.model,
            description: candidate.description,
            condition: candidate.condition,
            confidence: candidate.confidence,
            observedPriceCents: candidate.observedPriceCents,
            currency: candidate.currency,
            estimatedLowCents: candidate.estimatedLowCents,
            estimatedHighCents: candidate.estimatedHighCents,
            retailPriceCents: candidate.retailPriceCents,
            activePriceCents: candidate.activePriceCents,
            soldPriceCents: candidate.soldPriceCents,
            listPriceCents: candidate.listPriceCents,
            minimumOfferCents: candidate.minimumOfferCents,
            yardSalePriceCents: candidate.yardSalePriceCents,
            listingTitle: candidate.listingTitle,
            listingDescription: candidate.listingDescription,
            valueSummary: candidate.valueSummary,
            thumbnailKey,
            boxXMin: candidate.boundingBox.xMin,
            boxYMin: candidate.boundingBox.yMin,
            boxXMax: candidate.boundingBox.xMax,
            boxYMax: candidate.boundingBox.yMax,
            rawJson: JSON.stringify(candidate),
            lastSeenAt: capturedAt,
            seenCount: sql`${items.seenCount} + 1`,
          },
        })
        .returning();
      if (!saved) throw new Error("D1 did not return the saved item.");
      const id = saved.id;
      const duplicate = proposedId !== id;
      if (!duplicate) knownFingerprints.push({ id, fingerprint });

      await insertValuationSources(db, id, candidate.comparables, capturedAt);
      await replaceEditions(db, id, candidate.editions);
      const synced = await syncSelectedEdition(db, id);
      const [hydrated] = await hydrateItems(db, [synced]);
      detectedItems.push({ ...hydrated, duplicate });
    }

    if (detectedItems.length === 0) {
      await env.THUMBNAILS.delete(thumbnailKey);
    }

    const latencyMs = Date.now() - started;
    const completedAt = new Date().toISOString();
    if (detectedItems.length === 0) {
      console.info(
        JSON.stringify({
          message: "frame analysis returned no items",
          frameId,
          sessionId,
          capturedAt,
          latencyMs,
          model: env.OPENAI_MODEL,
          modelCalls: result.modelCalls,
          searchesPerformed: result.searchesPerformed,
        }),
      );
    }
    await db.insert(frameRuns).values({
      id: frameId,
      scanSessionId: sessionId,
      thumbnailKey,
      capturedAt,
      completedAt,
      latencyMs,
      itemCount: detectedItems.length,
      modelCalls: result.modelCalls,
      searchesPerformed: result.searchesPerformed,
      model: env.OPENAI_MODEL,
      instructions: result.audit.instructions,
      inputJson: JSON.stringify(result.audit.input),
      eventsJson: JSON.stringify(result.audit.events),
      rawResponsesJson: JSON.stringify(result.audit.rawResponses),
      outputJson: JSON.stringify(result.audit.output),
      usageJson: JSON.stringify(result.audit.usage),
      status: "completed",
      error: null,
    });
    await incrementStats(env, {
      frames: 1,
      items: detectedItems.length,
      searches: result.searchesPerformed,
      modelCalls: result.modelCalls,
    });

    const response: AnalysisResponse = {
      frameId,
      items: detectedItems,
      stats: await getStats(env),
      run: { latencyMs, modelCalls: result.modelCalls, searchesPerformed: result.searchesPerformed },
    };
    return Response.json(response);
  } catch (error) {
    const latencyMs = Date.now() - started;
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : "Frame analysis failed";
    await Promise.all([
      db.insert(frameRuns).values({
        id: frameId,
        scanSessionId: sessionId,
        thumbnailKey,
        capturedAt,
        completedAt,
        latencyMs,
        itemCount: 0,
        modelCalls: 0,
        searchesPerformed: 0,
        model: env.OPENAI_MODEL,
        instructions: agentInstructions(mode),
        inputJson: JSON.stringify({
          role: "user",
          content: [
            { type: "input_text", text: buildAgentInputText(findCriteria, mode) },
            { type: "input_image", image: "[frame stored in R2]", detail: "high" },
          ],
        }),
        eventsJson: "[]",
        rawResponsesJson: "[]",
        outputJson: "null",
        usageJson: "null",
        status: "failed",
        error: message.slice(0, 1000),
      }),
      incrementStats(env, { frames: 1, items: 0, searches: 0, modelCalls: 0 }),
      env.THUMBNAILS.delete(thumbnailKey),
    ]);
    throw error;
  }
}

async function getItems(env: Env, params: URLSearchParams): Promise<HistoryPage> {
  const db = drizzle(env.DB);
  const rows = await historyQuery(db, params);
  const page = rows.slice(0, HISTORY_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: await hydrateItems(db, page),
    nextCursor: rows.length > HISTORY_PAGE_SIZE && last
      ? JSON.stringify({ lastSeenAt: last.lastSeenAt, id: last.id })
      : null,
  };
}

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

async function deleteItem(env: Env, itemId: string): Promise<{ deletedId: string }> {
  const db = drizzle(env.DB);
  const storedItem = await db
    .select({ id: items.id, thumbnailKey: items.thumbnailKey })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!storedItem) throw new HttpError(404, "Find not found.");

  await db.delete(items).where(eq(items.id, itemId));
  const thumbnailStillUsed = await db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.thumbnailKey, storedItem.thumbnailKey))
    .limit(1)
    .then((rows) => rows.length > 0);
  if (!thumbnailStillUsed) await deleteThumbnailKeys(env, [storedItem.thumbnailKey]);

  return { deletedId: itemId };
}

async function deleteAllItems(env: Env): Promise<{ deleted: number }> {
  const db = drizzle(env.DB);
  const storedItems = await db.select({ id: items.id, thumbnailKey: items.thumbnailKey }).from(items);
  await db.delete(items);
  await deleteThumbnailKeys(env, [...new Set(storedItems.map((item) => item.thumbnailKey))]);
  return { deleted: storedItems.length };
}

async function deleteThumbnailKeys(env: Env, keys: string[]): Promise<void> {
  try {
    for (let index = 0; index < keys.length; index += 1_000) {
      await env.THUMBNAILS.delete(keys.slice(index, index + 1_000));
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: "thumbnail cleanup failed after deleting finds",
      keys: keys.length,
      error: error instanceof Error ? error.message : "Unknown R2 error",
    }));
  }
}

async function getFrameItems(env: Env, itemId: string): Promise<DetectedItem[]> {
  const db = drizzle(env.DB);
  const selected = await db.select().from(items).where(eq(items.id, itemId)).limit(1).then((rows) => rows[0]);
  if (!selected) throw new HttpError(404, "Find not found.");
  const rows = await db
    .select()
    .from(items)
    .where(eq(items.thumbnailKey, selected.thumbnailKey))
    .orderBy(desc(items.lastSeenAt));
  return hydrateItems(db, rows);
}

async function getAgentRunForItem(env: Env, itemId: string): Promise<AgentRunHistory> {
  const db = drizzle(env.DB);
  const selected = await db
    .select({ thumbnailKey: items.thumbnailKey })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!selected) throw new HttpError(404, "Find not found.");

  const run = await db
    .select()
    .from(frameRuns)
    .where(eq(frameRuns.thumbnailKey, selected.thumbnailKey))
    .orderBy(desc(frameRuns.capturedAt))
    .limit(1)
    .then((rows) => rows[0]);
  if (!run || !run.instructions) {
    throw new HttpError(404, "Agent activity was not recorded for this older find.");
  }

  return {
    frameId: run.id,
    scanSessionId: run.scanSessionId,
    thumbnailUrl: `/api/thumbnails/${selected.thumbnailKey}`,
    capturedAt: run.capturedAt,
    completedAt: run.completedAt,
    latencyMs: run.latencyMs,
    itemCount: run.itemCount,
    modelCalls: run.modelCalls,
    searchesPerformed: run.searchesPerformed,
    model: run.model ?? "Unknown model",
    status: run.status,
    error: run.error,
    instructions: run.instructions,
    input: parseJson(run.inputJson, null),
    events: parseJson<AgentRunEvent[]>(run.eventsJson, []),
    rawResponses: parseJson<unknown[]>(run.rawResponsesJson, []),
    output: parseJson(run.outputJson, null),
    usage: parseJson(run.usageJson, null),
  };
}

async function serveThumbnail(url: URL, env: Env): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice("/api/thumbnails/".length));
  if (!key.startsWith("frames/") || key.includes("..")) {
    throw new HttpError(400, "Invalid thumbnail key.");
  }
  const object = await env.THUMBNAILS.get(key);
  if (!object) throw new HttpError(404, "Thumbnail not found.");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

async function incrementStats(
  env: Env,
  delta: { frames: number; items: number; searches: number; modelCalls: number },
): Promise<void> {
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO app_stats (id, frames_processed, items_identified, searches_performed, model_calls, last_updated)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       frames_processed = frames_processed + excluded.frames_processed,
       items_identified = items_identified + excluded.items_identified,
       searches_performed = searches_performed + excluded.searches_performed,
       model_calls = model_calls + excluded.model_calls,
       last_updated = excluded.last_updated`,
  )
    .bind(delta.frames, delta.items, delta.searches, delta.modelCalls, updatedAt)
    .run();
}

async function getStats(env: Env): Promise<Stats> {
  const db = drizzle(env.DB);
  const row = await db.select().from(appStats).where(eq(appStats.id, 1)).limit(1).then((rows) => rows[0]);
  return {
    framesProcessed: row?.framesProcessed ?? 0,
    itemsIdentified: row?.itemsIdentified ?? 0,
    searchesPerformed: row?.searchesPerformed ?? 0,
    modelCalls: row?.modelCalls ?? 0,
    lastUpdated: row?.lastUpdated ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
