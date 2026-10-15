/**
 * Soil fetch service (#37) — populate a parcel's modelled soil profile.
 *
 * Flow (per parcel):
 *   1. Compute the parcel centroid (lon/lat) via geo.ts `ST_Centroid`
 *      (ParcelRepository.centroidLonLat). No geometry → skip, never throw.
 *   2. Round the centroid to a ~100 m grid cell (3 decimals) and look it up
 *      in the GLOBAL `SoilSample` cache. A hit is reused verbatim — we never
 *      refetch a nearby point, which is the primary SoilGrids fair-use
 *      guard (soil is static, so the cache TTL is effectively infinite).
 *   3. On a miss, call the configured provider (SoilGrids REST by default;
 *      SOIL_BASE_URL points at a self-hosted mirror as the fallback), then
 *      write the response into `SoilSample` for future parcels.
 *   4. Persist the profile onto the parcel (`soilType` + `soilJson`) and
 *      emit a `SOIL_FETCHED` audit event.
 *
 * The provider call runs inside the tenant context so a provider outage
 * surfaces as a thrown error the BullMQ job retries — the parcel simply
 * stays "soil pending" in the meantime. Parcel creation NEVER waits on or
 * is blocked by this (the trigger enqueues a job; see the parcel usecases).
 *
 * Every value here is a MODELLED ESTIMATE — see `SoilProfile`.
 *
 * @module app-layer/usecases/soil
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { ParcelRepository } from '../repositories/ParcelRepository';
import { logEvent } from '../events/audit';
import { fetchSoilProfile } from '@/lib/soil/soilgrids-client';
import type { SoilProfile } from '@/lib/soil/types';
import {
    computeSuitability,
    parseVarietySoilDefaults,
    type SuitabilityResult,
} from '@/lib/soil/suitability';
import { codedNotFound } from '@/lib/errors/types';
import { assertCanRead } from '../policies/common';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import type { Prisma } from '@prisma/client';

/** Grid resolution: 3 decimals ≈ 100 m at Bulgaria's latitude. */
function toE3(coord: number): number {
    return Math.round(coord * 1000);
}

export interface PlantingSoilSuitability {
    /** The parcel's modelled soil profile (null while "soil pending"). */
    soil: SoilProfile | null;
    /** Human soil label for a compact summary. */
    soilType: string | null;
    /** Advisory suitability verdict (good/caution/poor/unknown) + reason. */
    suitability: SuitabilityResult;
}

/**
 * Soil-aware suitability for a planting — compares the parcel's modelled soil
 * against the crop variety's curated soil preferences. Advisory only: yields
 * `unknown` (never a fabricated verdict) when the variety has no preferences
 * or the parcel has no soil. The `suitability.reasons[]` are exactly the
 * plain-language drivers the agronomy copilot consumes for its "why".
 */
export async function getPlantingSoilSuitability(
    ctx: RequestContext,
    plantingId: string,
): Promise<PlantingSoilSuitability> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const planting = await db.planting.findFirst({
            where: { id: plantingId, tenantId: ctx.tenantId, deletedAt: null },
            select: {
                parcel: { select: { soilJson: true, soilType: true } },
                variety: { select: { soilDefaultsJson: true } },
            },
        });
        if (!planting) throw codedNotFound('PLANTING_NOT_FOUND', 'Planting not found');

        const soil = (planting.parcel?.soilJson ?? null) as SoilProfile | null;
        const defaults = parseVarietySoilDefaults(planting.variety?.soilDefaultsJson ?? null);
        return {
            soil,
            soilType: planting.parcel?.soilType ?? null,
            suitability: computeSuitability(soil, defaults),
        };
    });
}

/**
 * Best-effort enqueue of a soil-fetch job for the given parcels. Called from
 * the parcel create / geometry-edit / import trigger points. NEVER throws —
 * soil is an async enrichment, so a Redis hiccup must not block or fail the
 * parcel write (graceful degradation → the parcel just stays "soil pending").
 */
export async function enqueueParcelSoilFetch(
    ctx: RequestContext,
    parcelIds: string[],
): Promise<void> {
    const ids = parcelIds.filter(Boolean);
    if (ids.length === 0) return;
    try {
        const { enqueue } = await import('../jobs/queue');
        await enqueue('soil-fetch', {
            tenantId: ctx.tenantId,
            initiatedByUserId: ctx.userId,
            parcelIds: ids,
        });
    } catch (err) {
        logger.warn('failed to enqueue soil-fetch (non-blocking)', {
            component: 'soil',
            tenantId: ctx.tenantId,
            count: ids.length,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

export type SoilFetchOutcome =
    | { status: 'skipped'; reason: 'no-centroid' }
    | { status: 'cached'; profile: SoilProfile }
    | { status: 'fetched'; profile: SoilProfile };

/** Resolve the human soil label: WRB group if present, else texture class. */
function soilTypeLabel(profile: SoilProfile): string | null {
    return profile.wrbClass ?? profile.textureClass ?? null;
}

/**
 * Fetch (or reuse cached) soil for one parcel and persist it. Idempotent —
 * re-running just refreshes the parcel from cache. Returns the outcome; the
 * caller (job) maps a `skipped` to a no-op and lets provider errors bubble
 * for retry.
 */
export async function fetchAndStoreParcelSoil(
    ctx: RequestContext,
    parcelId: string,
): Promise<SoilFetchOutcome> {
    const provider = env.SOIL_PROVIDER;

    // ── Phase 1 (tenant tx): resolve the centroid + consult the global cache.
    // Deliberately SHORT and network-free so the 5 s interactive-transaction
    // budget is never at risk. (SoilSample is global — no tenantId / no RLS.)
    const resolved = await runInTenantContext(ctx, async (db) => {
        const centroid = await ParcelRepository.centroidLonLat(db, ctx, parcelId);
        if (!centroid) return null;
        const latE3 = toE3(centroid.lat);
        const lonE3 = toE3(centroid.lon);
        const cached = await db.soilSample.findUnique({
            where: { latE3_lonE3: { latE3, lonE3 } },
        });
        return { centroid, latE3, lonE3, cached };
    });

    if (!resolved) return { status: 'skipped', reason: 'no-centroid' };
    const { centroid, latE3, lonE3, cached } = resolved;

    // ── Phase 2 (NO transaction): the provider HTTP call.
    // The external fetch MUST NOT run inside a Prisma interactive transaction —
    // holding a tenant tx open across a network round-trip blows the 5 s cap,
    // the transaction expires, and the write fails ("query cannot be executed
    // on an expired transaction"). That was the bug that left every parcel
    // stuck on "soil pending" and the SoilSample cache empty. Cache hits skip
    // the call entirely.
    let profile: SoilProfile;
    let fromCache = false;
    if (cached && cached.provider === provider) {
        profile = cached.dataJson as unknown as SoilProfile;
        fromCache = true;
    } else {
        profile = await fetchSoilProfile(centroid.lat, centroid.lon, {
            provider,
            baseUrl: env.SOIL_BASE_URL,
        });
    }

    // ── Phase 3 (tenant tx): persist the sample + parcel + audit — short,
    // network-free, comfortably inside the transaction budget.
    await runInTenantContext(ctx, async (db) => {
        if (!fromCache) {
            const dataJson = profile as unknown as Prisma.InputJsonValue;
            await db.soilSample.upsert({
                where: { latE3_lonE3: { latE3, lonE3 } },
                create: { latE3, lonE3, provider, dataJson },
                update: { provider, dataJson, fetchedAt: new Date() },
            });
        }

        await db.parcel.updateMany({
            where: { id: parcelId, tenantId: ctx.tenantId, deletedAt: null },
            data: {
                soilType: soilTypeLabel(profile),
                soilJson: profile as unknown as Prisma.InputJsonValue,
            },
        });

        await logEvent(db, ctx, {
            action: 'SOIL_FETCHED',
            entityType: 'Parcel',
            entityId: parcelId,
            details: `Soil ${fromCache ? 'reused from cache' : 'fetched'} (${soilTypeLabel(profile) ?? 'unknown'})`,
            detailsJson: {
                category: 'custom',
                event: 'soil_fetched',
                summary: `Soil ${fromCache ? 'reused from cache' : 'fetched'} for parcel`,
                provider,
                fromCache,
                textureClass: profile.textureClass,
                phH2o: profile.phH2o,
                gridCell: { latE3, lonE3 },
            },
        });
    });

    logger.info('parcel soil populated', {
        component: 'soil',
        parcelId,
        provider,
        fromCache,
        textureClass: profile.textureClass,
    });

    return fromCache
        ? { status: 'cached', profile }
        : { status: 'fetched', profile };
}
