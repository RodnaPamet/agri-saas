/**
 * Per-parcel satellite risk analysis (#13).
 *
 * For a single parcel, reduce its exact geometry over a recent cloud-masked
 * Sentinel-2 window to mean NDVI (vegetation) + NDMI (moisture) and derive a
 * traffic-light risk level for each. Numbers and levels only — there is no
 * per-parcel prose summary (see the fork note below). Degrades gracefully: with
 * no Earth-Engine credentials the indices are null and the levels are "unknown"
 * — the page still renders the parcel + the insurer "ask for offer" action.
 *
 * Cached per parcel per day in Redis, but ONLY when the analysis actually had
 * imagery. Caching a degraded ("unknown") reading would pin "No data" on the
 * parcel for the whole TTL after a one-off Earth-Engine hiccup, long past the
 * point where a retry would have succeeded.
 *
 * NO per-parcel AI summary — deliberate. The module used to advertise a Claude
 * summary it never produced (`summary` was hardcoded `null`). The whole-farm
 * briefing (`satellite-briefing.ts`) already delivers localised AI prose over
 * the same readings in ONE call; a per-parcel variant would mean one Claude
 * call per card per page render, and this usecase has no locale to generate in
 * (the client renders the levels through next-intl). The traffic-light levels
 * plus the NDVI/NDMI numbers carry the signal, so the promise was removed
 * rather than implemented.
 *
 * @module app-layer/usecases/parcel-risk
 */
import type { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { codedNotFound } from '@/lib/errors/types';
import { getRedis } from '@/lib/redis';
import { LocationRepository } from '../repositories/LocationRepository';
import { ParcelRepository } from '../repositories/ParcelRepository';
import {
    isGeeConfigured,
    getIndexMeansForPolygon,
    getIndexMeansPerPass,
    SCENE_SELECTION_VERSION,
    type IndexPass,
} from '@/lib/agro/earth-engine';

export type RiskLevel = 'good' | 'watch' | 'stress' | 'unknown';

export interface ParcelRiskResult {
    parcelId: string;
    name: string;
    areaHa: number | null;
    cropType: string | null;
    /** Whether Earth Engine is configured (drives the "estimate" vs "unavailable" copy). */
    configured: boolean;
    ndvi: number | null;
    ndmi: number | null;
    /** Vegetation-stress level from NDVI. */
    vegetation: RiskLevel;
    /** Moisture / drought level from NDMI. */
    moisture: RiskLevel;
    /** Worst of the two — the headline risk for the parcel. */
    overall: RiskLevel;
    /**
     * `YYYY-MM-DD` of the satellite pass the readings came from, or null when
     * there was no reading. NOT the request date: the composite falls back to
     * the latest available window, so this can be older than today.
     */
    acquiredDate: string | null;
    /** ISO timestamp the analysis was produced. */
    generatedAt: string;
}

const WINDOW_DAYS = 30;
const CACHE_TTL_SECONDS = 21_600; // 6h — matches the tile/briefing caches.

function ymd(d: Date): string {
    return d.toISOString().slice(0, 10);
}

/** NDVI → vegetation risk. Higher canopy vigour is better. */
function vegetationLevel(ndvi: number | null): RiskLevel {
    if (ndvi == null) return 'unknown';
    if (ndvi >= 0.6) return 'good';
    if (ndvi >= 0.35) return 'watch';
    return 'stress';
}

/** NDMI → moisture risk. Lower canopy moisture indicates drought stress. */
function moistureLevel(ndmi: number | null): RiskLevel {
    if (ndmi == null) return 'unknown';
    if (ndmi >= 0.1) return 'good';
    if (ndmi >= -0.1) return 'watch';
    return 'stress';
}

const SEVERITY: Record<RiskLevel, number> = { unknown: 0, good: 1, watch: 2, stress: 3 };
function worst(a: RiskLevel, b: RiskLevel): RiskLevel {
    return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/**
 * Analyse one parcel's satellite risk. `now` is injectable for tests. Never
 * throws on an EE/AI failure — those degrade to null readings.
 */
export async function analyzeParcelRisk(
    ctx: RequestContext,
    parcelId: string,
    opts: { now?: Date } = {},
): Promise<ParcelRiskResult> {
    assertCanRead(ctx);
    const now = opts.now ?? new Date();
    const date = ymd(now);
    const cacheKey = `parcel-risk:v1:${ctx.tenantId}:${parcelId}:${date}`;

    const redis = getRedis();
    if (redis) {
        try {
            const cached = await redis.get(cacheKey);
            if (cached) return JSON.parse(cached) as ParcelRiskResult;
        } catch {
            /* redis hiccup — regenerate */
        }
    }

    // Load the parcel (name/area/crop) + its geometry (tenant-scoped).
    const { parcel, geometry } = await runInTenantContext(ctx, async (db) => {
        const p = await db.parcel.findFirst({
            where: { id: parcelId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true, areaHa: true, cropType: true },
        });
        if (!p) throw codedNotFound('PARCEL_NOT_FOUND', 'Parcel not found');
        const g = await ParcelRepository.geometryForParcel(db, ctx, parcelId);
        return { parcel: p, geometry: g };
    });

    const configured = isGeeConfigured();
    let ndvi: number | null = null;
    let ndmi: number | null = null;
    let acquiredDate: string | null = null;
    if (configured && geometry) {
        const win = {
            start: ymd(new Date(now.getTime() - WINDOW_DAYS * 86_400_000)),
            end: date,
        };
        try {
            const means = await getIndexMeansForPolygon(geometry, win);
            ndvi = means.ndvi;
            ndmi = means.ndmi;
            acquiredDate = means.acquiredDate;
        } catch {
            /* no clear pixels / EE error — leave null, degrade to "unknown" */
        }
    }

    const vegetation = vegetationLevel(ndvi);
    const moisture = moistureLevel(ndmi);
    const overall = worst(vegetation, moisture);
    const areaHa = parcel.areaHa != null ? Number(parcel.areaHa) : null;

    const result: ParcelRiskResult = {
        parcelId: parcel.id,
        name: parcel.name,
        areaHa,
        cropType: parcel.cropType,
        configured,
        ndvi,
        ndmi,
        vegetation,
        moisture,
        overall,
        acquiredDate,
        generatedAt: now.toISOString(),
    };

    // Cache ONLY a reading that actually had imagery — mirrors the
    // `if (briefing && redis)` rule in `satellite-briefing.ts`. A transient EE
    // failure (or a deploy with no credentials) yields null indices and an
    // "unknown" level; persisting that would show the farmer "No data" for the
    // full 6h TTL even after Earth Engine recovered. Uncached ⇒ the next
    // request retries.
    const hasImagery = ndvi != null || ndmi != null;
    if (hasImagery && redis) {
        try {
            await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
        } catch {
            /* still returned, just uncached */
        }
    }
    return result;
}


// ─────────────────────────────────────────────────────────────────────────
// Batch: a whole block's parcels — #2631
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parcels analysed in ONE batch call.
 *
 * A bound is required because `getIndexMeansForPolygon` takes one geometry and
 * `src/lib/agro/earth-engine.ts` has no FeatureCollection variant, so a cold
 * cache costs one Earth Engine round trip per parcel. 24 covers the great
 * majority of blocks on this product while keeping a cold call bounded; a
 * block with more reports a PARTIAL answer rather than a slow one.
 */
export const MAX_BATCH_PARCELS = 24;

/** Parcels analysed concurrently. Bounded so a cold block is not 24 simultaneous EE calls. */
const BATCH_CONCURRENCY = 4;

/** One satellite pass, carrying the SAME reading shape as the card. */
export interface ParcelRiskPass {
    date: string;
    ndvi: number | null;
    ndmi: number | null;
    vegetation: RiskLevel;
    moisture: RiskLevel;
    overall: RiskLevel;
    /**
     * Where this pass came from — #2837 stage 1b.
     *
     * `stored` is final: it was computed on an earlier request and read back
     * from `ParcelIndexReading`. `earthengine` was computed DURING this
     * request, which is the only case in which a slow or failing Earth Engine
     * can shorten the series. So this is what tells a client whether a
     * shorter-than-expected window is worth retrying, which is why it is
     * exposed rather than kept as an implementation detail (`agrent-ios`
     * asked for it and decodes it as optional).
     */
    source: 'stored' | 'earthengine';
}

export interface ParcelRiskHistoryResult {
    parcelId: string;
    days: number;
    configured: boolean;
    passes: ParcelRiskPass[];
    /** The pass cap was hit — there is more history than this. */
    truncated: boolean;
    generatedAt: string;
}

/** Bound on the window a caller may ask for. */
export const HISTORY_MIN_DAYS = 7;
/**
 * What a client gets when it names no window.
 *
 * 14, matching the phone's own default rather than the widest useful window
 * (owner, relayed by `agrent-ios` 2026-11-07: "info based on a time period,
 * like the past 14 days"). The two defaults agreeing is the point — a server
 * default of 60 and a client default of 14 means the one caller that omits
 * the parameter gets a different answer from every caller that sends it, and
 * `days` is in the cache key, so it would also be its own cache entry that
 * nothing else ever reads.
 *
 * Clients should still send `days` explicitly: the phone offers 14 / 30 / 60,
 * and a default is a fallback, not a contract.
 */
export const HISTORY_DEFAULT_DAYS = 14;
export const HISTORY_MAX_DAYS = 120;
/**
 * Pass cap. Sentinel-2 revisits every ~5 days and two orbits can both see a
 * field, so 120 days is roughly 24-48 images; 60 leaves headroom without
 * letting a pathological collection return an unbounded list.
 */
const HISTORY_PASS_CAP = 60;

/**
 * The per-pass NDVI/NDMI series for one parcel — #2837.
 *
 * ## Why a separate read rather than a field on `analyzeParcelRisk`
 *
 * Different cache lifetime. Today's reading changes when the DAY turns; a
 * 60-day series changes when a PASS arrives. Folding them together would make
 * every caller that wants only today's level pay for the series, and the
 * existing response is fetched for the parcel card on every screen open.
 *
 * ## The levels come from the card's own functions
 *
 * `vegetationLevel` / `moistureLevel` / `worst`, not copies of their
 * thresholds. `agrent-ios` caught the first draft of this inventing a second
 * vocabulary (`ndviLevel: "GOOD"`, `"ADEQUATE"`) — words that exist nowhere in
 * this codebase — and the fix is not just the right spelling but the shared
 * function: two call sites cannot drift when somebody retunes `>= 0.6`.
 *
 * A pass is therefore structurally the card's reading minus the parcel
 * identity, so the phone decodes one `RiskLevel` on both screens and no chart
 * point can be coloured by a different scale from the card above it.
 *
 * ## Degrades, never throws, on an Earth Engine failure
 *
 * An empty `passes` with `configured: true` is the same shape as a parcel the
 * satellite genuinely has not seen, which is deliberate: the caller's job is
 * to draw what exists, and a 500 here would take out the «Риск» section over
 * a chart. `configured: false` is the distinguishable case — Earth Engine is
 * not set up, so there is nothing to wait for.
 */
export async function getParcelRiskHistory(
    ctx: RequestContext,
    parcelId: string,
    days: number,
    opts: { now?: Date } = {},
): Promise<ParcelRiskHistoryResult> {
    assertCanRead(ctx);

    // A non-finite `days` (NaN from a bad query string that the route let
    // through) must not become the cache key, so it resolves to the default
    // before clamping rather than after.
    const asked = Number.isFinite(days) ? Math.floor(days) : HISTORY_DEFAULT_DAYS;
    const requested = Math.min(HISTORY_MAX_DAYS, Math.max(HISTORY_MIN_DAYS, asked));
    const now = opts.now ?? new Date();
    const date = ymd(now);
    // `days` is IN the key: a 30-day and a 60-day request are different
    // answers and must not share an entry.
    const cacheKey = `parcel-risk-history:v1:${ctx.tenantId}:${parcelId}:${requested}:${date}`;

    const redis = getRedis();
    if (redis) {
        try {
            const cached = await redis.get(cacheKey);
            if (cached) return JSON.parse(cached) as ParcelRiskHistoryResult;
        } catch {
            /* redis hiccup — regenerate */
        }
    }

    const windowStart = ymd(new Date(now.getTime() - requested * DAY_MS));

    // ── Read what we already hold ────────────────────────────────────
    //
    // Geometry comes along even when the stored record turns out to be
    // complete: deciding that needs the watermark, which this same read
    // returns, and a second tenant transaction to fetch a polygon we may not
    // need costs a round trip and a pool slot either way.
    const stored = await runInTenantContext(ctx, async (db) => {
        const rows = await ParcelRepository.storedIndexReadings(db, ctx, parcelId, parseYmd(windowStart));
        if (!rows) throw codedNotFound('PARCEL_NOT_FOUND', 'Parcel not found');
        const geometry = await ParcelRepository.geometryForParcel(db, ctx, parcelId);
        return { ...rows, geometry };
    });

    const configured = isGeeConfigured();

    // ── Decide what, if anything, to ask Earth Engine ────────────────
    // A watermark written under a DIFFERENT scene-selection algorithm is not
    // evidence about this one — see `SCENE_SELECTION_VERSION`. Treated as
    // absent, which re-searches the window under the current rules.
    const sameAlgo = stored.coveredAlgo === SCENE_SELECTION_VERSION;
    const ranges =
        configured && stored.geometry
            ? uncoveredRanges(
                  windowStart,
                  date,
                  sameAlgo ? stored.coveredFrom : null,
                  sameAlgo ? stored.coveredThrough : null,
                  now,
              )
            : [];

    const fresh = new Map<string, IndexPass>();
    let allRangesSucceeded = true;
    for (const range of ranges) {
        try {
            const raw = await getIndexMeansPerPass(stored.geometry, range, HISTORY_PASS_CAP);
            for (const pass of raw) fresh.set(pass.date, pass);
        } catch {
            // Degrade: the stored half of the answer is still worth serving,
            // and the watermark must NOT advance over a range we failed to
            // search or nothing will ever come back for it.
            allRangesSucceeded = false;
        }
    }

    // ── Persist, OUTSIDE the read transaction ────────────────────────
    //
    // Deliberately a second tenant context rather than one that spans the
    // Earth Engine calls. `EE_CALL_TIMEOUT_MS` is 25s and `PG_POOL_MAX` is 12,
    // so holding a connection across those calls would let twelve concurrent
    // chart opens exhaust the pool — and a transaction open for 25s is a long
    // time to hold the per-tenant locks an audited write takes.
    if (fresh.size > 0) {
        try {
            await runInTenantContext(ctx, async (db) => {
                await ParcelRepository.storeIndexReadings(
                    db,
                    ctx,
                    parcelId,
                    [...fresh.values()].map((pass) => ({
                        acquiredOn: parseYmd(pass.date),
                        ndvi: pass.ndvi,
                        ndmi: pass.ndmi,
                    })),
                    allRangesSucceeded
                        ? {
                              from: parseYmd(windowStart),
                              through: parseYmd(date),
                              algo: SCENE_SELECTION_VERSION,
                          }
                        : null,
                );
            });
        } catch {
            // The reading is still returned. A failed WRITE must not fail a
            // READ: the caller asked for a chart, and the only cost of not
            // storing is that the next request asks Earth Engine again.
        }
    }

    // ── Merge ────────────────────────────────────────────────────────
    //
    // Fresh wins per date. Both halves come from the same algorithm on the
    // same imagery, so a disagreement means the archive was reprocessed and
    // the newer answer is the better one.
    const byDate = new Map<string, ParcelRiskPass>();
    for (const row of stored.readings) {
        const d = ymd(row.acquiredOn);
        byDate.set(d, toPass(d, row.ndvi, row.ndmi, 'stored'));
    }
    for (const pass of fresh.values()) {
        byDate.set(pass.date, toPass(pass.date, pass.ndvi, pass.ndmi, 'earthengine'));
    }

    // Oldest first: a trend reads left to right, and the caller should not
    // have to sort to draw one.
    const ordered = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const truncated = ordered.length > HISTORY_PASS_CAP;
    const passes = truncated ? ordered.slice(-HISTORY_PASS_CAP) : ordered;

    const result: ParcelRiskHistoryResult = {
        parcelId,
        days: requested,
        configured,
        passes,
        truncated,
        generatedAt: now.toISOString(),
    };

    // Only cache a series that has something in it, for `analyzeParcelRisk`'s
    // reason: caching an Earth Engine failure would hold the empty answer for
    // the full TTL even after EE recovered.
    //
    // A series assembled while a range FAILED is likewise not cached: it is
    // short through no fault of the data, and pinning it for 6h would hide
    // the recovery the next request would otherwise find.
    if (redis && passes.length > 0 && allRangesSucceeded) {
        try {
            await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
        } catch {
            /* still returned, just uncached */
        }
    }

    return result;
}

/** One day in ms — named because it appears in three window calculations. */
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → a UTC midnight Date, the shape a `@db.Date` column wants. */
function parseYmd(d: string): Date {
    return new Date(`${d}T00:00:00.000Z`);
}

function shiftYmd(d: string, days: number): string {
    return ymd(new Date(parseYmd(d).getTime() + days * DAY_MS));
}

function toPass(
    date: string,
    ndvi: number | null,
    ndmi: number | null,
    source: 'stored' | 'earthengine',
): ParcelRiskPass {
    const vegetation = vegetationLevel(ndvi);
    const moisture = moistureLevel(ndmi);
    return { date, ndvi, ndmi, vegetation, moisture, overall: worst(vegetation, moisture), source };
}

/**
 * Which date ranges in `[start, end]` still need an Earth Engine call — #2837.
 *
 * ## Two reasons a range is needed, and they are not the same reason
 *
 * 1. **Never asked.** The coverage watermark is a single interval, so the
 *    requested window can stick out of it at either end — at most two gaps.
 * 2. **The recent tail, always.** Sentinel-2 L2A for the last few days is
 *    still being processed, so a day already inside the watermark can gain a
 *    pass afterwards. Without this, a chart would freeze at whatever the
 *    first request happened to see and never show a new pass again.
 *
 * `TAIL_REFRESH_DAYS` is 7 — one ~5-day revisit cycle plus processing
 * latency — so the tail call is small and bounded however long the requested
 * window is. Combined with the 6h cache that is at most four short calls per
 * parcel per day, against one call per question before this.
 *
 * Returns at most two ranges, merged when they touch, oldest first.
 */
export function uncoveredRanges(
    start: string,
    end: string,
    coveredFrom: Date | null,
    coveredThrough: Date | null,
    now: Date,
): Array<{ start: string; end: string }> {
    // Nothing has ever been asked for this parcel: one call for the lot.
    if (!coveredFrom || !coveredThrough) return [{ start, end }];

    const from = ymd(coveredFrom);
    const through = ymd(coveredThrough);
    const tailStart = ymd(new Date(now.getTime() - TAIL_REFRESH_DAYS * DAY_MS));

    const out: Array<{ start: string; end: string }> = [];

    // (1) the window reaching back before anything we have searched
    if (start < from) {
        out.push({ start, end: minYmd(end, shiftYmd(from, -1)) });
    }

    // (2) everything from the later of (just after the watermark) and (the
    //     refresh tail) up to today. `minYmd` rather than a choice between
    //     them: if the watermark ends BEFORE the tail begins there is a real
    //     gap in the middle, and asking from the earlier of the two covers
    //     both the gap and the tail in one call.
    const afterStart = maxYmd(start, minYmd(shiftYmd(through, 1), tailStart));
    if (afterStart <= end) out.push({ start: afterStart, end });

    // Merge when the two touch, so the common cold-ish case is one call.
    if (out.length === 2 && shiftYmd(out[0].end, 1) >= out[1].start) {
        return [{ start: out[0].start, end: out[1].end }];
    }
    return out;
}

const minYmd = (a: string, b: string): string => (a <= b ? a : b);
const maxYmd = (a: string, b: string): string => (a >= b ? a : b);

/**
 * How far back to re-ask Earth Engine regardless of the coverage watermark.
 *
 * Sentinel-2 revisits in ~5 days and L2A processing lags by hours to a day or
 * two, so a date already marked as searched can gain a pass afterwards. 7 days
 * covers a full revisit plus that latency.
 */
const TAIL_REFRESH_DAYS = 7;

export interface BlockRiskResult {
    locationId: string;
    locationName: string;
    /** Parcels analysed in THIS call. */
    analysed: number;
    /**
     * Parcels the block HAS. `analysed < total` means the answer is PARTIAL,
     * and every caller must say so.
     *
     * This field is the whole reason the batch exists. `RiskLevel` already has
     * an `unknown` member, so a caller counting levels would score an
     * un-analysed parcel as merely unknown — and a reader counting "0 stressed"
     * across 3 of 30 parcels gets a confident answer about a farm nobody
     * looked at. A result that cannot express its own incompleteness is read
     * as complete.
     */
    total: number;
    /** Worst `overall` across the analysed parcels. */
    worst: RiskLevel;
    /** How many ANALYSED parcels sit at each level. Sums to `analysed`. */
    counts: Record<RiskLevel, number>;
    /** Per parcel, so a caller can name the stressed ones rather than count them. */
    parcels: ParcelRiskResult[];
    /** Whether Earth Engine is configured at all. */
    configured: boolean;
    generatedAt: string;
}

/**
 * Analyse every parcel in a block, bounded, reusing the per-parcel day cache.
 *
 * ## Why it calls `analyzeParcelRisk` rather than reimplementing
 *
 * The thresholds (`vegetationLevel`, `moistureLevel`, `worst`) are the product
 * decision here, and two copies of them would drift — the same rule that keeps
 * `scripts/lib/api-routes.ts` single. Reusing the per-parcel function also
 * reuses its Redis key, so a block whose parcels the operator already opened
 * one-by-one on the farm-risk page costs nothing, and the page warms this.
 *
 * ## The transaction CLOSES before the satellite calls
 *
 * Both reads happen in ONE `runInTenantContext` which then returns. The
 * analyses run after it, deliberately:
 *
 *   - `runInTenantContext` IS a `$transaction`, and `analyzeParcelRisk` opens
 *     its own, so running them inside would nest — a second pool connection
 *     while the first is held, which is #1191's P0.8 deadlock at
 *     `PG_POOL_MAX`.
 *   - Holding a connection across up to 24 Earth Engine round trips would tie
 *     a pool slot to a remote compute service for the duration.
 *
 * ## A failing parcel is EXCLUDED, never substituted
 *
 * `analyzeParcelRisk` degrades an EE failure to null readings by design, so a
 * throw here means something structural — a parcel deleted between the id
 * query and the analysis. That parcel is dropped from `parcels` and therefore
 * from `analysed`, which keeps the denominator honest. Inserting a synthetic
 * `unknown` row would inflate `analysed` and claim a parcel was looked at.
 */
export async function analyzeBlockRisk(
    ctx: RequestContext,
    locationId: string,
    opts: { now?: Date } = {},
): Promise<BlockRiskResult> {
    assertCanRead(ctx);
    const now = opts.now ?? new Date();

    // ONE transaction for both reads, closed before any analysis begins.
    const { locationName, ids, total } = await runInTenantContext(ctx, async (db) => {
        const location = await LocationRepository.getById(db, ctx, locationId);
        // A block that does not exist must NOT read as a block with no
        // parcels: the second answer is "nothing to worry about" about a farm
        // we never found.
        if (!location) throw codedNotFound('LOCATION_NOT_FOUND', 'Location not found');
        return {
            locationName: location.name,
            total: await ParcelRepository.countForLocation(db, ctx, locationId),
            ids: await ParcelRepository.listIdsForLocation(db, ctx, locationId, MAX_BATCH_PARCELS),
        };
    });

    const parcels: ParcelRiskResult[] = [];
    for (let i = 0; i < ids.length; i += BATCH_CONCURRENCY) {
        const slice = ids.slice(i, i + BATCH_CONCURRENCY);
        const settled = await Promise.allSettled(
            slice.map((p) => analyzeParcelRisk(ctx, p.id, { now })),
        );
        for (const r of settled) {
            if (r.status === 'fulfilled') parcels.push(r.value);
        }
    }

    const counts: Record<RiskLevel, number> = { unknown: 0, good: 0, watch: 0, stress: 0 };
    let worstLevel: RiskLevel = 'unknown';
    for (const p of parcels) {
        counts[p.overall] += 1;
        worstLevel = worst(worstLevel, p.overall);
    }

    return {
        locationId,
        locationName,
        analysed: parcels.length,
        total,
        worst: worstLevel,
        counts,
        configured: isGeeConfigured(),
        parcels,
        generatedAt: now.toISOString(),
    };
}
