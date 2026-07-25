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
import { notFound } from '@/lib/errors/types';
import { getRedis } from '@/lib/redis';
import { ParcelRepository } from '../repositories/ParcelRepository';
import { isGeeConfigured, getIndexMeansForPolygon } from '@/lib/agro/earth-engine';

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
        if (!p) throw notFound('Parcel not found');
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
