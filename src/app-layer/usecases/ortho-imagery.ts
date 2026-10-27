/**
 * «Ортофотокарта» — МЗХ imagery, flight dates and physical blocks (#2421).
 *
 * Three reads the phone makes: a tile, the flight date for an area, and the
 * ФБ outlines over it. All three come through here so the gate, the year
 * resolution and the cache policy are decided once.
 *
 * @module usecases/ortho-imagery
 */

import type { RequestContext } from '../types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { getRedis } from '@/lib/redis';
import { notFound } from '@/lib/errors/types';
import { tileTo3857Bbox, tileToLonLatBbox, isTileInBulgaria } from '@/lib/geo/cadastre-tiles';
import { bboxTouchesBulgaria } from '@/lib/geo/ortho-bbox';
import {
    ORTHO_ATTRIBUTION,
    ORTHO_YEARS,
    buildOrthoBlocksUrl,
    buildOrthoCoverageUrl,
    buildOrthoTileUrl,
    isBlankOrthoTile,
    isOrthoZoomAllowed,
    orthoCoverageCacheKey,
    orthoTileAbsentKey,
    orthoTileCacheKey,
    resolveOrthoSource,
    sofiaFlightDate,
    type LonLatBbox,
    type OrthoSource,
} from '@/lib/geo/ortho-source';

/** The runtime flag. Dark by default; see `feature-flag-keys.ts`. */
export const ORTHO_FLAG = 'agro.orthophoto';

/** A tile lives a long time: imagery for a past year does not change. */
const TILE_TTL_SECONDS = 604_800; // 7 days

/**
 * A NEGATIVE lives a shorter life than a tile.
 *
 * "No imagery anywhere" is true until the Ministry flies the area again, and
 * a new flight year appears without telling us. A week would mean an area
 * photographed in March is still reported bare in April.
 */
const ABSENT_TTL_SECONDS = 86_400; // 1 day

/** Coverage is per area and changes on the same cadence as a new flight. */
const COVERAGE_TTL_SECONDS = 86_400;

/**
 * The tile cache's bound, and the number a person can read.
 *
 * Redis has no per-prefix size limit, so a TTL alone is not a bound: at z19 a
 * few farms panning around accumulate tiles faster than a 7-day TTL retires
 * them. A counter alongside the entries gives both halves — a ceiling that
 * actually stops, and a figure someone can look at.
 *
 * 200,000 tiles at the ~10 KB measured for a real 256² tile is roughly 2 GB,
 * which is the number to argue with rather than this one. Past the ceiling
 * tiles are still SERVED, just not stored: degrading to a slower map beats
 * evicting someone else's working set or filling the instance.
 */
const TILE_CACHE_MAX_ENTRIES = 200_000;
const TILE_COUNT_KEY = 'ortho:tilecount:v1';

/**
 * Bound on concurrent upstream requests, per server instance.
 *
 * MapKit asks for every visible tile at once — ~15-20 on a cold screen, over
 * one HTTP/2 connection — so misses arrive as a burst, not a trickle. Four at
 * a time clears 20 misses in about 1.5 s at the measured 0.1-0.3 s each,
 * which is inside the phone's 15 s timeout with room to spare, and it keeps a
 * single farm from opening twenty sockets to a government service.
 */
const UPSTREAM_CONCURRENCY = 4;

/**
 * How long a tile request will wait in total before giving up.
 *
 * The phone's own timeout is 15 s with no retry, and its contract is to treat
 * a timeout as retryable but a 204 as final. So holding past its deadline is
 * strictly worse than answering 503: the request dies either way, and only the
 * 503 arrives in time to be read as retryable. 10 s leaves the margin.
 */
const UPSTREAM_BUDGET_MS = 10_000;

let inFlight = 0;
const waiting: Array<() => void> = [];

/** Take an upstream slot, or null when the budget expires first. */
async function acquireSlot(budgetMs: number): Promise<(() => void) | null> {
    if (inFlight < UPSTREAM_CONCURRENCY) {
        inFlight++;
        return releaseOnce();
    }
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            // Drop our waiter so a later release does not hand a slot to a
            // request that has already been answered.
            const i = waiting.indexOf(grant);
            if (i >= 0) waiting.splice(i, 1);
            resolve(null);
        }, budgetMs);
        function grant(): void {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            inFlight++;
            resolve(releaseOnce());
        }
        waiting.push(grant);
    });
}

/**
 * A release that cannot double-release.
 *
 * Without the guard, a caller that released in both a `finally` and an error
 * path would decrement twice and permanently widen the bound — the failure
 * mode of every hand-rolled semaphore.
 */
function releaseOnce(): () => void {
    let released = false;
    return () => {
        if (released) return;
        released = true;
        inFlight--;
        const next = waiting.shift();
        if (next) next();
    };
}

/** Test seam: the limiter is module state, so a suite must be able to reset it. */
export function __resetOrthoLimiterForTests(): void {
    inFlight = 0;
    waiting.length = 0;
}

/**
 * The gate every ortho read shares.
 *
 * Two refusals, both 404, and both meaning "this surface does not exist here":
 *
 *   - the flag is off for this caller — `assertFeatureEnabled` already answers
 *     404 rather than 403, deliberately, so a dark surface is not
 *     discoverable;
 *   - `ORTHO_WMS_URL` is unset, which is the shipped state until МЗХ answers
 *     the licence enquiry.
 *
 * **The server enforces the flag, not just the client.** The phone hides the
 * map mode when the flag is off, and that is not where the licence position
 * can rest: a stale or modified client would otherwise still be served
 * imagery. The peer argued for this independently and is right.
 */
async function assertOrthoAvailable(ctx: RequestContext): Promise<OrthoSource> {
    await assertFeatureEnabled(ORTHO_FLAG, ctx.userId);
    const src = resolveOrthoSource();
    if (!src) throw notFound('Not found');
    return src;
}

export interface OrthoCoverage {
    /** The newest year with imagery over this area, or null when none has. */
    year: number | null;
    /** `YYYY-MM-DD` in Bulgaria, or null when the source gave no date. */
    flightDate: string | null;
    attribution: string;
}

interface Deps {
    fetchImpl?: typeof fetch;
}

/** One upstream GET, inside the concurrency bound. Null means unavailable. */
async function upstream(
    url: string,
    deps: Deps,
    accept: string,
): Promise<globalThis.Response | null> {
    const release = await acquireSlot(UPSTREAM_BUDGET_MS);
    if (!release) return null;
    try {
        const fetchImpl = deps.fetchImpl ?? fetch;
        // Never forward the caller's cookies: the upstream is a public service
        // and has no business seeing our session.
        return await fetchImpl(url, {
            headers: { Accept: accept },
            signal: AbortSignal.timeout(UPSTREAM_BUDGET_MS),
        });
    } catch {
        return null;
    } finally {
        release();
    }
}

/**
 * The newest year with imagery over `bbox`, from the flight-date polygons.
 *
 * Searched newest-first and STOPS at the first year with a feature, which is
 * the whole point of resolving per area rather than probing per tile: without
 * it, a cold pan of twenty tiles asks six years each.
 *
 * Measured at the probe point (~43.08N 24.40E): `Dates_2023` and `Dates_2020`
 * have coverage, 2025/2024/2022/2021 have none, and the imagery agrees —
 * `Orthoimagery_2023` returns a real tile there while 2025 and 2024 return the
 * blank. So "newest" must mean "newest that COVERS this area": taking the
 * highest year number would have served the blank and, under the 204 rule
 * below, told the phone there is no photograph of land that is photographed.
 */
export async function resolveOrthoCoverage(
    ctx: RequestContext,
    bbox: LonLatBbox,
    deps: Deps = {},
): Promise<OrthoCoverage> {
    const src = await assertOrthoAvailable(ctx);
    const redis = getRedis();
    const key = orthoCoverageCacheKey(bbox);

    if (redis) {
        try {
            const hit = await redis.get(key);
            if (hit) return JSON.parse(hit) as OrthoCoverage;
        } catch {
            /* a Redis hiccup must not cost the answer */
        }
    }

    let found: OrthoCoverage = { year: null, flightDate: null, attribution: ORTHO_ATTRIBUTION };

    // An area outside Bulgaria has no Ministry imagery by definition, so this
    // is a real answer rather than a shortcut — and it keeps us from asking a
    // government service about Greece six times for a farmer who panned too
    // far. Cached like any other negative.
    if (!bboxTouchesBulgaria(bbox)) {
        await cacheCoverage(key, found);
        return found;
    }

    for (const year of ORTHO_YEARS) {
        const res = await upstream(buildOrthoCoverageUrl(src.url, year, bbox), deps, 'application/json');
        // Unavailable is NOT "no coverage": returning null year here would be
        // cached as a fact. Give up and report what we know, uncached.
        if (!res) return found;
        if (!res.ok) continue;
        const json = (await res.json().catch(() => null)) as
            | { features?: Array<{ properties?: Record<string, unknown> }> }
            | null;
        const first = json?.features?.[0];
        if (!first) continue;
        // `Date`, not `FlightDate` — measured. An ISO timestamp, and
        // `2023-10-13T21:00:00Z` is midnight in Sofia on the 14th, so the
        // calendar day has to be read in Bulgaria or the flight is reported a
        // day early.
        found = {
            year,
            flightDate: sofiaFlightDate(first.properties?.Date as string | undefined),
            attribution: ORTHO_ATTRIBUTION,
        };
        break;
    }

    await cacheCoverage(key, found);
    return found;
}

async function cacheCoverage(key: string, value: OrthoCoverage): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
        await redis.set(key, JSON.stringify(value), 'EX', COVERAGE_TTL_SECONDS);
    } catch {
        /* still answered, just uncached */
    }
}

export type OrthoTile =
    /** Imagery. */
    | { kind: 'image'; bytes: Buffer; contentType: string; year: number }
    /**
     * No imagery here, and that is FINAL — answer 204.
     *
     * The phone caches a 204 for the session and draws plain ground, so this
     * must only ever mean "the Ministry has not photographed this", never "we
     * could not find out".
     */
    | { kind: 'absent' }
    /**
     * We could not find out — answer 503.
     *
     * Distinguishing this from `absent` is the single most important decision
     * in this module. The existing cadastre proxy answers 204 for upstream
     * errors too, which is right for MapLibre and wrong here: the phone would
     * cache a transient failure as a permanent absence and show bare ground
     * for the rest of the session. A 503 is retried on the next redraw.
     */
    | { kind: 'unavailable' };

/** Serve one tile, deciding between imagery, a final absence, and a failure. */
export async function fetchOrthoTile(
    ctx: RequestContext,
    z: number,
    x: number,
    y: number,
    deps: Deps = {},
): Promise<OrthoTile> {
    const src = await assertOrthoAvailable(ctx);

    // Structural and geographic bounds first — never a fetch for a tile that
    // cannot hold Bulgarian imagery. Both are final absences: no amount of
    // retrying makes z23 or a tile over Portugal exist here.
    if (!isOrthoZoomAllowed(z)) return { kind: 'absent' };
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
        return { kind: 'absent' };
    }
    if (!isTileInBulgaria(z, x, y)) return { kind: 'absent' };

    const redis = getRedis();
    const absentKey = orthoTileAbsentKey(z, x, y);

    if (redis) {
        try {
            // The negative first: it is the cheaper question and the common
            // answer over two thirds of the country for any given year.
            if (await redis.get(absentKey)) return { kind: 'absent' };
        } catch {
            /* fall through */
        }
    }

    const coverage = await resolveOrthoCoverage(ctx, tileToLonLatBbox(z, x, y), deps);
    if (coverage.year === null) {
        // Nothing covers this area in any year we serve. Cache the negative,
        // or every uncovered tile re-asks six years of WFS forever.
        await rememberAbsent(absentKey);
        return { kind: 'absent' };
    }

    const tileKey = orthoTileCacheKey(coverage.year, z, x, y);
    if (redis) {
        try {
            const hit = await redis.get(tileKey);
            if (hit) {
                return {
                    kind: 'image',
                    // Base64 because a Redis string round-trip can corrupt raw
                    // binary under the default encoding — the same reason the
                    // cadastre proxy stores tiles this way.
                    bytes: Buffer.from(hit, 'base64'),
                    contentType: 'image/jpeg',
                    year: coverage.year,
                };
            }
        } catch {
            /* fall through and fetch */
        }
    }

    const res = await upstream(
        buildOrthoTileUrl(src.url, coverage.year, tileTo3857Bbox(z, x, y)),
        deps,
        'image/jpeg,*/*',
    );
    if (!res) return { kind: 'unavailable' };
    if (!res.ok) return { kind: 'unavailable' };

    const bytes = Buffer.from(await res.arrayBuffer());

    if (isBlankOrthoTile(bytes.byteLength)) {
        // A 200 carrying the source's blank tile. The area is covered by this
        // year's flight polygon and still has no pixels here — an edge of the
        // flight block. Final, and cached as such.
        await rememberAbsent(absentKey);
        return { kind: 'absent' };
    }

    if (redis) {
        try {
            const count = await redis.incr(TILE_COUNT_KEY);
            if (count <= TILE_CACHE_MAX_ENTRIES) {
                await redis.set(tileKey, bytes.toString('base64'), 'EX', TILE_TTL_SECONDS);
            } else {
                // Past the ceiling: serve, do not store, and give the counter
                // back so it reports the cache's size rather than the number
                // of attempts.
                await redis.decr(TILE_COUNT_KEY);
            }
        } catch {
            /* served uncached */
        }
    }

    return {
        kind: 'image',
        bytes,
        contentType: res.headers.get('content-type') ?? 'image/jpeg',
        year: coverage.year,
    };
}

async function rememberAbsent(key: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
        await redis.set(key, '1', 'EX', ABSENT_TTL_SECONDS);
    } catch {
        /* the answer stands; it is just re-derived next time */
    }
}

export interface OrthoBlock {
    id: string;
    usage: string | null;
    usageCode: string | null;
    geometry: unknown;
}

export interface OrthoBlocks {
    year: number | null;
    features: OrthoBlock[];
    /** True when the cap cut the list — the client must not read it as "all". */
    truncated: boolean;
}

/** The server's own cap, independent of whatever the client asks for. */
const BLOCKS_MAX_FEATURES = 600;

/**
 * The physical blocks over an area.
 *
 * Capped here rather than trusting the client's bbox discipline. The phone
 * asks for blocks only below 0.12° (or 0.3° for the farm's own bounds), which
 * keeps a request bounded — but a cap that lives only in the client is not a
 * cap, and `truncated` is what stops a cut list reading as a complete one.
 */
export async function fetchOrthoBlocks(
    ctx: RequestContext,
    bbox: LonLatBbox,
    deps: Deps = {},
): Promise<OrthoBlocks> {
    const src = await assertOrthoAvailable(ctx);
    const coverage = await resolveOrthoCoverage(ctx, bbox, deps);
    if (coverage.year === null) return { year: null, features: [], truncated: false };

    // One over the cap, so a full page is distinguishable from an exact fit.
    const res = await upstream(
        buildOrthoBlocksUrl(src.url, coverage.year, bbox, BLOCKS_MAX_FEATURES + 1),
        deps,
        'application/json',
    );
    if (!res || !res.ok) return { year: coverage.year, features: [], truncated: false };

    const json = (await res.json().catch(() => null)) as
        | { features?: Array<{ properties?: Record<string, unknown>; geometry?: unknown }> }
        | null;
    const raw = json?.features ?? [];
    const truncated = raw.length > BLOCKS_MAX_FEATURES;

    const features: OrthoBlock[] = [];
    for (const f of raw.slice(0, BLOCKS_MAX_FEATURES)) {
        const id = f.properties?.PHBIDENT;
        // Read leniently: a feature without the Ministry's own identifier is
        // not something we can label, and dropping it beats drawing an
        // unnamed outline the farmer cannot match to a document.
        if (typeof id !== 'string' || !id || !f.geometry) continue;
        features.push({
            id,
            usage: typeof f.properties?.USAGEBUL === 'string' ? f.properties.USAGEBUL : null,
            usageCode: typeof f.properties?.USAGECODE === 'string' ? f.properties.USAGECODE : null,
            geometry: f.geometry,
        });
    }

    return { year: coverage.year, features, truncated };
}
