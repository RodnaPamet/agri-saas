/**
 * Google Earth Engine (GEE) — satellite vegetation-index tile generation
 * (server-only).
 *
 * Computes a recent cloud-masked Sentinel-2 index composite (NDVI / NDMI /
 * NDRE / GNDVI / EVI) for a field's area-of-interest and returns an
 * EPHEMERAL XYZ tile-URL template
 * (`https://earthengine.googleapis.com/.../{z}/{x}/{y}`) via `getMap`,
 * which the MapLibre raster overlay consumes directly. GEE does both the
 * compute and the tile serving — we host no tile server.
 *
 * Every index shares the SAME pipeline (bounds → cloud-masked S2 collection
 * → per-image band math → per-pixel median → clip → `getMap`); only the
 * band math and the colour ramp differ, so they live in `INDEX_SPECS` and
 * `getIndexTileUrl` runs the common path. The per-index `get<Index>TileUrl`
 * wrappers keep a stable named export per tile-route.
 *
 * Auth is a GEE service account (`GEE_SERVICE_ACCOUNT_KEY` = the full JSON
 * key as a string; `GEE_PROJECT_ID` = the Earth-Engine-registered Cloud
 * project). Both are OPTIONAL: when either is absent `isGeeConfigured()`
 * is false and callers skip — so CI / contributor builds need no creds.
 *
 * This module is `serverExternalPackages`-listed (next.config.js) so the
 * heavy EE client never reaches the browser bundle; it is only ever
 * imported from the `/agro/<index>-tiles` routes.
 */
import ee from '@google/earthengine';
import { env } from '@/env';
import type { VegetationIndex } from '@/lib/agro/vegetation-indices';
import { INDEX_RECIPES } from '@/lib/agro/index-recipes';
import { isGeeConfigured } from '@/lib/agro/gee-config';

// The credential predicate lives in the EE-free `gee-config` module so a page
// shell / health probe / startup hook can ask "is satellite on?" without
// importing this module's heavy `@google/earthengine` client. Re-exported here
// because every existing caller (and the route unit tests that mock
// `@/lib/agro/earth-engine`) imports it from this path.
export { isGeeConfigured };

/**
 * Loosely-typed Earth Engine value. The EE client is a fluent, deeply
 * dynamic SDK (every method returns another EE object); this keeps the
 * chain typed without leaking `any` into the module.
 */
type EeImage = { [method: string]: (...args: unknown[]) => EeImage };

/** AOI as a lon/lat bounding box — the location's parcel bounds. */
export interface NdviAoi {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface NdviWindow {
    /** Inclusive start date, `YYYY-MM-DD`. */
    start: string;
    /** Exclusive end date, `YYYY-MM-DD`. */
    end: string;
}

// Earth Engine auth + initialize is process-global and must run exactly
// once. The in-flight promise is memoised so concurrent requests share a
// single handshake; a rejection clears it so a transient failure can be
// retried on the next request rather than poisoning the process.
/**
 * Earth Engine budgets, and why an UNBOUNDED call was the defect.
 *
 * Every EE round-trip here is a callback API wrapped in a promise. A wrapper
 * with no deadline never settles if the callback is never invoked — and a hang
 * is NOT a throw, so neither the `try/catch` in these functions nor the soft
 * `generation_failed` arm in `index-tiles-handler.ts` can see it. The request
 * simply never completes: the user's browser gives up and says the server did
 * not respond, while the five index buttons all fail together because they
 * share one handshake.
 *
 * The init case was the worst of the five. `initPromise` is memoised at module
 * scope, and its `.catch` clears the memo so a transient failure retries — the
 * comment above it says exactly that, and it is true of REJECTIONS. A hang
 * leaves the promise pending for ever, so the memo is never cleared and every
 * later request in that container awaits a promise that will never settle.
 * Sticky until the container is replaced, which is why this comes back rather
 * than flickering. Making the timeout a REJECTION is what re-arms that retry:
 * it flows through the same `.catch`.
 *
 * Budgets are deliberately below a browser's patience, because a timeout the
 * user never waits for buys nothing: the point is to return the honest
 * "couldn't load imagery" state while they are still looking at the map.
 */
const EE_INIT_TIMEOUT_MS = 10_000;
const EE_CALL_TIMEOUT_MS = 25_000;

/**
 * Promisify an EE callback with a DEADLINE.
 *
 * This is the only `new Promise` in this module, and
 * `tests/guards/earth-engine-calls-are-bounded.test.ts` asserts that — a second
 * one is how an unbounded call gets back in.
 */
function withEeDeadline<T>(
    label: string,
    timeoutMs: number,
    build: (resolve: (value: T) => void, reject: (err: unknown) => void) => void,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        // Cleared on settle: a pending 25s timer holds the event loop open and
        // would delay a worker's exit for every call that succeeded quickly.
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`${label} did not respond within ${timeoutMs}ms`));
        }, timeoutMs);
        const ok = (value: T) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const bad = (err: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
        };
        // A callback arriving AFTER the deadline must not double-settle, and a
        // synchronous throw inside `build` must reject rather than escape into
        // the caller's stack where the deadline would not apply.
        try {
            build(ok, bad);
        } catch (err) {
            bad(err);
        }
    });
}

let initPromise: Promise<void> | null = null;

function initEarthEngine(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = withEeDeadline<void>('EE auth+initialize', EE_INIT_TIMEOUT_MS, (resolve, reject) => {
        if (!isGeeConfigured()) {
            reject(new Error('Earth Engine is not configured'));
            return;
        }
        let key: Record<string, unknown>;
        try {
            key = JSON.parse(env.GEE_SERVICE_ACCOUNT_KEY as string);
        } catch {
            reject(new Error('GEE_SERVICE_ACCOUNT_KEY is not valid JSON'));
            return;
        }
        ee.data.authenticateViaPrivateKey(
            key,
            () => {
                ee.initialize(
                    null,
                    null,
                    () => resolve(),
                    (err: unknown) => reject(new Error(`EE initialize failed: ${String(err)}`)),
                    null,
                    env.GEE_PROJECT_ID,
                );
            },
            (err: unknown) => reject(new Error(`EE auth failed: ${String(err)}`)),
        );
    }).catch((err) => {
        initPromise = null; // allow retry on the next request
        throw err;
    });
    return initPromise;
}

/**
 * Build the per-image band-math function for `index` from its recipe.
 * `normalizedDifference` covers the four ratio indices (scale-invariant, so
 * raw S2 DN is fine); EVI is the enhanced-VI expression whose additive
 * constant needs TRUE reflectance, so each band is divided by the S2 10000
 * DN scale. `EeImage` keeps the fluent EE chain typed without leaking `any`.
 *
 * Sentinel-2 SR bands: B2 blue, B3 green, B4 red, B5 red-edge-1, B8 NIR.
 */
function bandFn(index: VegetationIndex): (img: EeImage) => EeImage {
    const math = INDEX_RECIPES[index].math;
    if (math.kind === 'normalizedDifference') {
        const bands = math.bands;
        return (img) => img.normalizedDifference(bands).rename(index.toUpperCase());
    }
    // EVI
    return (img) =>
        img
            .expression('2.5 * ((NIR - RED) / (NIR + 6 * RED - 7.5 * BLUE + 1))', {
                NIR: img.select('B8').divide(10000),
                RED: img.select('B4').divide(10000),
                BLUE: img.select('B2').divide(10000),
            })
            .rename('EVI');
}

/**
 * The SCL classes this pipeline treats as unusable: 3 cloud shadow, 8 cloud
 * medium probability, 9 cloud high probability, 10 thin cirrus, 11 snow/ice.
 *
 * ONE definition, four call sites. It was four copies of the same chain until
 * #2837's parcel-level cloud filter needed a FIFTH reader — and a filter that
 * decides which scenes enter the collection, keyed on a different set of
 * classes from the mask that then reduces them, would admit a pass as "clear
 * over the parcel" and reduce it to nothing. The two have to be the same
 * answer by construction, not by both being correct today.
 */
function sclClearMask(img: EeImage): EeImage {
    const scl = img.select('SCL');
    return scl.neq(3).and(scl.neq(8)).and(scl.neq(9)).and(scl.neq(10)).and(scl.neq(11));
}

/**
 * Which SCENE-SELECTION algorithm `adaptiveS2Collection` implements — #2837.
 *
 * Bump this whenever a change alters WHICH passes enter the collection: the
 * tile-level cloud threshold, the masked classes, the window widening, the
 * collection id. Stored readings record the version that produced them, and
 * `getParcelRiskHistory` treats a parcel's coverage watermark as ABSENT when
 * it does not match — so a bump re-searches every parcel automatically.
 *
 * That is the point of the constant rather than a migration that nulls the
 * watermark: a selection change that admits MORE passes leaves every existing
 * watermark claiming dates were searched when they were searched under rules
 * that rejected the pass. Nothing would ever go back for them, the chart would
 * silently keep the old answer, and no test would fail. Remembering to write
 * the UPDATE is exactly the step that gets forgotten.
 *
 * It does NOT cover a change to the INDEX arithmetic (`bandFn`) or the
 * reducer: those change a stored pass's VALUE, not whether the pass exists,
 * and the recent-tail refresh plus the upsert handle a value change for the
 * dates anybody is looking at. A wholesale re-read of history for a changed
 * band formula is a backfill job, not a watermark reset.
 *
 * 1 — the original: `CLOUDY_PIXEL_PERCENTAGE < 60` at tile level, SCL classes
 *     3/8/9/10/11 masked, scale 20.
 * 2 — judge cloud over the PARCEL (#2837, owner 2026-11-07): the tile-level
 *     pre-filter relaxes to `< 90` and a pass is kept only when its
 *     SCL-clear share over the geometry is at least
 *     `MIN_PARCEL_CLEAR_SHARE`. Applies to the two polygon readers; the tile
 *     and bounds paths are unchanged, so this version describes the
 *     per-parcel collection only.
 */
export const SCENE_SELECTION_VERSION = 2;

/**
 * Tile-level `CLOUDY_PIXEL_PERCENTAGE` ceiling for the PARCEL readers.
 *
 * 90 rather than 60, and it is kept rather than dropped. `CLOUDY_PIXEL_PERCENTAGE`
 * is a figure about a ~100x100 km granule, so at 60 a pass that is clear over
 * one field and cloudy across the tile never reaches the SCL mask at all —
 * which is the owner's complaint: parcel 15655-19 read «Заснето на 28
 * октомври» ten days later because every November pass was filtered out at
 * tile level.
 *
 * It does not go away entirely, because a genuinely overcast granule has no
 * clear parcel in it and still costs a per-image `reduceRegion` to find that
 * out. 90 keeps the hopeless cases out of the collection while letting through
 * everything that could plausibly be clear over one field.
 */
const PARCEL_TILE_CLOUD_MAX = 90;

/**
 * How much of the parcel an SCL-clear pass has to cover to be kept.
 *
 * 0.5 (owner's call relayed via `agrent-ios`, confirmed with the peer). At 0.7
 * a field under the edge of a cloud is discarded while two thirds of it is
 * perfectly readable; the field mean is already computed over clear pixels
 * ONLY, so a half-clear pass yields a real answer over a smaller area rather
 * than a wrong one over the whole.
 *
 * Not lower, because the smaller the clear patch the less the mean describes
 * the FIELD — at 0.1 a reading is one corner standing in for the parcel, and
 * a trend made of different corners is not a trend.
 */
const MIN_PARCEL_CLEAR_SHARE = 0.5;

/**
 * What fraction of `region` this pass sees without cloud, shadow, cirrus or
 * snow — an `ee.Number` between 0 and 1.
 *
 * `unmask(0)` is the load-bearing call. `SCL` is MASKED outside the granule
 * footprint, and `reduceRegion`'s mean ignores masked pixels — so a scene
 * clipping one corner of a parcel would report a clear share of 1.0 for the
 * sliver it covers and be kept as a full reading of the field. Unmasking to 0
 * makes "outside this granule" count as not-clear, which is what the share is
 * supposed to mean.
 *
 * Same scale (20) and same SCL classes as the reducer that follows, through
 * `sclClearMask`, so a pass admitted as clear cannot then reduce to nothing.
 */
function parcelClearShare(img: EeImage, region: EeImage): EeImage {
    const clear = sclClearMask(img).unmask(0).rename('clear');
    const stats = (
        clear as unknown as { reduceRegion: (a: Record<string, unknown>) => EeImage }
    ).reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: region,
        scale: 20,
        maxPixels: 1e9,
        bestEffort: true,
    });
    // `get` on an empty reduction yields null, and `ee.Number(null)` fails a
    // comparison rather than returning false — so the absent case is coerced
    // to 0, which the filter then rejects.
    const eeX = ee as unknown as {
        Number: (v: unknown) => EeImage;
        Algorithms: { If: (c: unknown, t: unknown, f: unknown) => unknown };
    };
    const raw = (stats as unknown as { get: (k: string) => unknown }).get('clear');
    return eeX.Number(eeX.Algorithms.If(raw, raw, 0));
}

/**
 * Cloud-filtered S2_SR_HARMONIZED collection for `region`, ADAPTIVE on the
 * date window: prefer the requested `[win.start, win.end)`, but when that
 * window holds NO imagery — the common cause of a blank overlay: the wall
 * clock has run ahead of the published Sentinel-2 archive, or a cloudy stretch
 * emptied the window — fall back to a same-length window ending on the LATEST
 * available acquisition. So the composite is never empty while ANY recent
 * imagery exists, and the date picker still drives the window when data is
 * there. `ee` is untyped; the fluent chain is `EeImage`.
 *
 * ## `judgeCloudOverRegion` — opt-in, and why it is not the default
 *
 * With it, the tile-level `CLOUDY_PIXEL_PERCENTAGE` ceiling relaxes to
 * `PARCEL_TILE_CLOUD_MAX` and each pass is kept on its own SCL-clear share
 * over `region` instead. That is what the owner asked for (2026-11-07), and it
 * is the right judgement for a PARCEL: a figure about a granule says nothing
 * about one field.
 *
 * It is deliberately NOT on for the tile and bounds readers, whose `region` is
 * a location BOUNDING BOX rather than a field. Two reasons, and the second
 * decided it. A clear share over a bbox spanning a whole farm is a different
 * quantity from a clear share over one field, so 0.5 there would mean
 * something nobody has chosen. And it costs a `reduceRegion` per image in the
 * collection, on the path that serves map tiles in bulk — where the current
 * filter is one property comparison.
 *
 * The consequence is that an NDVI overlay and a parcel card can be built from
 * different sets of scenes, and so can report different acquisition dates.
 * They already differ in their geometry (bbox versus polygon), so this widens
 * an existing gap rather than opening one; closing it means deciding what a
 * clear share over a bbox should mean, which is a separate question.
 */
function adaptiveS2Collection(
    region: EeImage,
    win: NdviWindow,
    opts: { judgeCloudOverRegion?: boolean } = {},
): EeImage {
    // `ee.Date` / `ee.Algorithms` (and the object-arg ImageCollection ctor) are
    // real EE members missing from the `EarthEngine` type defs — reach them
    // through a narrow typed view rather than `any`.
    const eeX = ee as unknown as {
        Date: (v: unknown) => EeImage;
        Algorithms: { If: (cond: unknown, t: unknown, f: unknown) => EeImage };
        ImageCollection: (v: unknown) => EeImage;
    };
    const perRegion = opts.judgeCloudOverRegion === true;
    let base = ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filter(
            ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', perRegion ? PARCEL_TILE_CLOUD_MAX : 60),
        );
    if (perRegion) {
        // Per-image, server-side: how much of THIS geometry the pass sees
        // clear, then keep only the passes that see enough of it. Set as a
        // property and filtered rather than computed in TypeScript, because
        // the whole point is that the collection — the adaptive fallback's
        // `latest` below included — is built from region-clear passes. That
        // fallback is what makes `acquiredDate` the newest pass actually clear
        // over the parcel rather than the newest pass in a clear-ish granule.
        base = base
            .map((img: EeImage) =>
                (img as unknown as { set: (k: string, v: unknown) => EeImage }).set(
                    'regionClearShare',
                    parcelClearShare(img, region),
                ),
            )
            .filter(
                (
                    ee.Filter as unknown as {
                        gte: (property: string, value: number) => unknown;
                    }
                ).gte('regionClearShare', MIN_PARCEL_CLEAR_SHARE),
            );
    }
    const windowColl = base.filterDate(win.start, win.end);
    const windowDays = Math.max(1, Math.round((Date.parse(win.end) - Date.parse(win.start)) / 86_400_000));
    const latest = eeX.Date(base.sort('system:time_start', false).first().get('system:time_start'));
    const fallback = base.filterDate(latest.advance(-windowDays, 'day'), latest.advance(1, 'day'));
    return eeX.ImageCollection(eeX.Algorithms.If(windowColl.size().gt(0), windowColl, fallback));
}

/**
 * The date of the NEWEST acquisition actually in `collection`, `YYYY-MM-DD`.
 *
 * Load-bearing for honest labelling: because {@link adaptiveS2Collection} may
 * silently fall back to a window ending on the latest available acquisition,
 * the composite can be older than the date the caller asked for — so reporting
 * the REQUESTED date as "as of" would be a lie. Callers surface this value
 * instead.
 *
 * Fail-soft by contract: any EE hiccup resolves `null` (caller falls back to
 * the requested date) rather than sinking a tile/means request that otherwise
 * succeeded. Costs one extra `evaluate`, issued in parallel with the main one.
 */
async function resolveAcquiredDate(collection: EeImage): Promise<string | null> {
    try {
        const aggregated = (
            collection as unknown as {
                aggregate_max: (prop: string) => {
                    evaluate: (cb: (value: unknown, err?: unknown) => void) => void;
                };
            }
        ).aggregate_max('system:time_start');

        const millis = await withEeDeadline<unknown>(
            'EE aggregate_max',
            EE_CALL_TIMEOUT_MS,
            (resolve, reject) => {
            aggregated.evaluate((value: unknown, err?: unknown) => {
                if (err) {
                    reject(new Error(`EE aggregate_max failed: ${String(err)}`));
                    return;
                }
                resolve(value);
            });
        });

        if (typeof millis !== 'number' || !Number.isFinite(millis)) return null;
        return new Date(millis).toISOString().slice(0, 10);
    } catch {
        // Never break an otherwise-good composite over a missing label.
        return null;
    }
}

/** A rendered index composite: its ephemeral tile template + the imagery's real date. */
export interface IndexTileResult {
    /** Ephemeral XYZ `{z}/{x}/{y}` tile-URL template from `getMap`. */
    tileUrl: string;
    /**
     * `YYYY-MM-DD` of the newest acquisition in the composite, or `null` when
     * EE couldn't report it. May be OLDER than the requested window end — see
     * {@link adaptiveS2Collection} — which is exactly why it is returned.
     */
    acquiredDate: string | null;
}

/**
 * Build a recent cloud-masked Sentinel-2 composite of `index` for `aoi` over
 * the `[start, end)` window and return its ephemeral XYZ tile-URL template
 * alongside the imagery's ACTUAL acquisition date.
 *
 * Shared pipeline for every index: filter S2_SR_HARMONIZED to the bounds +
 * date window + <60% cloud, drop cloud/shadow/snow pixels via the SCL
 * scene-classification band, apply the index's per-image band math, take the
 * per-pixel median over the window (so a single cloudy pass never blanks the
 * field), clip to the AOI, and render via `getMap` with the index's ramp.
 */
export async function getIndexTileUrl(
    index: VegetationIndex,
    aoi: NdviAoi,
    win: NdviWindow,
    clipGeometry?: unknown,
): Promise<IndexTileResult> {
    await initEarthEngine();

    const recipe = INDEX_RECIPES[index];
    const band = bandFn(index);
    // The bbox rectangle is the cheap collection-bounds filter; the RENDERED
    // composite is clipped to `clipGeometry` (the parcel polygon(s)) when given
    // so the raster stops at the field boundary instead of filling the whole
    // bounding box. Falls back to the rectangle when no geometry is passed.
    const region = ee.Geometry.Rectangle([aoi.west, aoi.south, aoi.east, aoi.north]);
    const clipRegion = clipGeometry
        ? new (ee.Geometry as unknown as { new (g: unknown): EeImage })(clipGeometry)
        : region;

    const collection = adaptiveS2Collection(region, win);

    // SCL classes to mask: 3 cloud-shadow, 8 cloud-medium, 9 cloud-high,
    // 10 thin-cirrus, 11 snow/ice. `EeImage` keeps the fluent EE chain
    // typed (every method returns another EE object) without leaking
    // `any` — the `@google/earthengine` module itself is untyped.
    const masked = collection.map((img: EeImage) => {
        return img.updateMask(sclClearMask(img));
    });

    const composite: EeImage = masked.map((img: EeImage) => band(img)).median().clip(clipRegion);

    const visParams = { min: recipe.min, max: recipe.max, palette: recipe.palette };

    // Both round-trips are issued together — the date label must not add a
    // serial hop to the tile request. `resolveAcquiredDate` never rejects.
    const [urlFormat, acquiredDate] = await Promise.all([
        withEeDeadline<string>('EE getMap', EE_CALL_TIMEOUT_MS, (resolve, reject) => {
            composite.getMap(
                visParams,
                (map: { urlFormat?: string } | null, err?: unknown) => {
                    if (err || !map?.urlFormat) {
                        reject(new Error(`EE getMap failed: ${String(err ?? 'no urlFormat')}`));
                        return;
                    }
                    resolve(map.urlFormat);
                },
            );
        }),
        resolveAcquiredDate(collection),
    ]);

    return { tileUrl: urlFormat, acquiredDate };
}

/**
 * How NDVI is DISTRIBUTED across the parcel, not just its average — #2837
 * stage 2.
 *
 * A field mean of 0.5 can be a uniformly mediocre crop or an excellent one
 * with a failing corner, and those call for different actions. The
 * percentiles say which.
 *
 * ## The denominator is the CLEAR area, not the parcel
 *
 * Every figure here is computed over the pixels this composite could actually
 * see: `reduceRegion` ignores masked pixels, and the SCL mask removes cloud,
 * shadow, cirrus and snow. So `belowThresholdShare: 0.3` means "30% of what
 * we can see is in stress", NOT "30% of the field". That is the honest
 * reading — nothing can be said about ground under cloud — and it is stated
 * here because a client would otherwise reasonably assume the field.
 *
 * Deliberately NOT unmasked to zero: counting cloud as not-in-stress would
 * make a mostly-clouded parcel look healthy, which is the dangerous
 * direction. Counting it as in-stress would cry wolf. Reporting the share of
 * what was visible is the only one of the three that does not invent a
 * reading.
 */
export interface WithinFieldStats {
    /** NDVI 10th percentile over the clear area — the weakest tenth. */
    ndviP10: number | null;
    /** Median NDVI. Compare with `ndvi` (the mean): a mean well below the
     *  median means a minority of very poor pixels is dragging it down. */
    ndviP50: number | null;
    ndviP90: number | null;
    /**
     * Share of the CLEAR area whose NDVI is below `threshold`, 0..1.
     * `null` when the composite saw nothing.
     */
    belowThresholdShare: number | null;
    /**
     * The NDVI value `belowThresholdShare` was computed against, echoed so a
     * client never has to assume it. Supplied by the caller, which holds the
     * same constant the risk levels use — see `NDVI_STRESS_THRESHOLD`.
     */
    threshold: number;
}

/** Field-area mean vegetation-index readings (the AI-briefing input). */
export interface FieldIndexMeans {
    /**
     * Mean NDVI over the AOI for the window, rounded to 3 dp. Range −1..1;
     * healthy dense canopy ≈ 0.6–0.9, bare/senescent ≈ 0.1–0.3. `null` when
     * the composite yielded no clear pixels over the AOI.
     */
    ndvi: number | null;
    /**
     * Mean NDMI (moisture) over the AOI, rounded to 3 dp. Range −1..1; lower
     * values indicate drier canopy / water stress. `null` when unavailable.
     */
    ndmi: number | null;
    /**
     * `YYYY-MM-DD` of the newest acquisition the means were reduced over, or
     * `null` when EE couldn't report it. May be OLDER than the requested window
     * end (the adaptive-window fallback), so callers label with THIS, not the
     * date they asked for.
     */
    acquiredDate: string | null;
    /**
     * The NDVI distribution across the parcel — #2837 stage 2. `null` when
     * the caller did not ask for it (no `stressThreshold`), which is every
     * caller that only needs the means.
     */
    withinField: WithinFieldStats | null;
}

/**
 * Compute the field-area MEAN NDVI + NDMI for `aoi` over the `[start, end)`
 * window — the numeric counterpart to `getIndexTileUrl` (which renders tiles).
 *
 * Same cloud-masked Sentinel-2 median composite the tile path uses, but
 * instead of `getMap` it runs a single `reduceRegion(mean)` over the AOI
 * rectangle (both index bands in one reduce → one EE round-trip). Returns a
 * plain `{ ndvi, ndmi }` value so the AI field-briefing usecase can reason
 * over concrete numbers. Throws on an EE failure (the caller treats a throw
 * as "no satellite reading for this field" and degrades gracefully).
 */
export async function getIndexMeansForBounds(
    aoi: NdviAoi,
    win: NdviWindow,
): Promise<FieldIndexMeans> {
    await initEarthEngine();

    const region = ee.Geometry.Rectangle([aoi.west, aoi.south, aoi.east, aoi.north]);

    const collection = adaptiveS2Collection(region, win);

    // Same SCL cloud/shadow/snow mask as the tile pipeline.
    const masked = collection.map((img: EeImage) => {
        return img.updateMask(sclClearMask(img));
    });

    const ndviBand = bandFn('ndvi');
    const ndmiBand = bandFn('ndmi');
    const ndvi = masked.map((img: EeImage) => ndviBand(img)).median();
    const ndmi = masked.map((img: EeImage) => ndmiBand(img)).median();
    // One multi-band image → a single reduceRegion returns both means.
    const combined = (ndvi as EeImage).addBands(ndmi).clip(region);

    const reduced = (
        combined as unknown as {
            reduceRegion: (args: Record<string, unknown>) => {
                evaluate: (cb: (value: unknown, err?: unknown) => void) => void;
            };
        }
    ).reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: region,
        // 20 m keeps the reduce cheap over a whole-field box; NDVI/NDMI are
        // slowly-varying so 20 m vs the native 10 m is immaterial for a mean.
        scale: 20,
        maxPixels: 1e9,
        bestEffort: true,
    });

    const [info, acquiredDate] = await Promise.all([
        withEeDeadline<Record<string, unknown>>('EE reduceRegion', EE_CALL_TIMEOUT_MS, (resolve, reject) => {
            reduced.evaluate((value: unknown, err?: unknown) => {
                if (err) {
                    reject(new Error(`EE reduceRegion failed: ${String(err)}`));
                    return;
                }
                resolve((value ?? {}) as Record<string, unknown>);
            });
        }),
        resolveAcquiredDate(collection),
    ]);

    const round3 = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;

    // Band names are the uppercased index names from `bandFn`'s `.rename(...)`.
    return {
        ndvi: round3(info.NDVI),
        ndmi: round3(info.NDMI),
        acquiredDate,
        // No distribution for a BOUNDING BOX. Percentiles over a rectangle
        // spanning a whole farm describe the farm's variation between fields,
        // not variation within one — and this reader's callers want the
        // briefing's two numbers. Explicit `null` rather than an optional
        // field so a future reader has to decide rather than inherit.
        withinField: null,
    };
}

/**
 * Per-PARCEL variant of {@link getIndexMeansForBounds} (#13). Identical
 * masked-median-composite reduce, but the region is the parcel's exact
 * geometry (a GeoJSON Polygon / MultiPolygon) rather than a location bbox — so
 * the NDVI/NDMI means describe just that field, not the whole location's
 * bounding box. Throws on an EE failure; the caller degrades to "no reading".
 */
export async function getIndexMeansForPolygon(
    geometry: unknown,
    win: NdviWindow,
    opts: { stressThreshold?: number } = {},
): Promise<FieldIndexMeans> {
    await initEarthEngine();

    // `ee.Geometry(geojson)` accepts a GeoJSON geometry object directly.
    const region = new (ee.Geometry as unknown as { new (g: unknown): EeImage })(geometry);

    // #2837: judge cloud over THIS PARCEL rather than over the ~100x100 km
    // granule — see `PARCEL_TILE_CLOUD_MAX`. Opt-in, so the tile and bounds
    // readers keep their cheaper tile-level filter unchanged.
    const collection = adaptiveS2Collection(region, win, { judgeCloudOverRegion: true });

    const masked = collection.map((img: EeImage) => {
        return img.updateMask(sclClearMask(img));
    });

    const ndviBand = bandFn('ndvi');
    const ndmiBand = bandFn('ndmi');
    const ndvi = masked.map((img: EeImage) => ndviBand(img)).median();
    const ndmi = masked.map((img: EeImage) => ndmiBand(img)).median();

    const threshold = opts.stressThreshold;
    // #2837 stage 2: the distribution rides the SAME `reduceRegion` as the
    // means. A separate call for the percentiles would be a second metered
    // Earth Engine round trip over pixels this one is already scanning.
    //
    // The below-threshold band is `ndvi.lt(threshold)` — 0/1 — whose MEAN is
    // the share. It inherits the SCL mask, so the share is of the CLEAR area;
    // `WithinFieldStats` records why that is the right denominator and why it
    // is deliberately not unmasked.
    const bands =
        threshold === undefined
            ? (ndvi as EeImage).addBands(ndmi)
            : (ndvi as EeImage)
                  .addBands(ndmi)
                  .addBands(
                      (ndvi as unknown as { lt: (v: number) => EeImage })
                          .lt(threshold)
                          .rename('NDVIBELOW'),
                  );
    const combined = bands.clip(region);

    const eeR = ee.Reducer as unknown as {
        mean: () => { combine: (a: Record<string, unknown>) => unknown };
        percentile: (ps: number[]) => unknown;
    };
    // `.combine` SUFFIXES every output — `NDVI_mean`, `NDVI_p10`, … — so the
    // keys read back below are NOT the bare band names they were before this
    // change. Combined unconditionally rather than behind the `threshold`
    // branch: one output shape is easier to read back correctly than two, and
    // percentiles over pixels already being scanned cost nothing.
    const reducer = eeR.mean().combine({
        reducer2: eeR.percentile([10, 50, 90]),
        sharedInputs: true,
    });

    const reduced = (
        combined as unknown as {
            reduceRegion: (args: Record<string, unknown>) => {
                evaluate: (cb: (value: unknown, err?: unknown) => void) => void;
            };
        }
    ).reduceRegion({
        reducer,
        geometry: region,
        scale: 20,
        maxPixels: 1e9,
        bestEffort: true,
    });

    const [info, acquiredDate] = await Promise.all([
        withEeDeadline<Record<string, unknown>>('EE reduceRegion', EE_CALL_TIMEOUT_MS, (resolve, reject) => {
            reduced.evaluate((value: unknown, err?: unknown) => {
                if (err) {
                    reject(new Error(`EE reduceRegion failed: ${String(err)}`));
                    return;
                }
                resolve((value ?? {}) as Record<string, unknown>);
            });
        }),
        resolveAcquiredDate(collection),
    ]);

    const round3 = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;

    return {
        // `_mean`, not `NDVI`: the reducer is combined — see the note above it.
        ndvi: round3(info.NDVI_mean),
        ndmi: round3(info.NDMI_mean),
        acquiredDate,
        withinField:
            threshold === undefined
                ? null
                : {
                      ndviP10: round3(info.NDVI_p10),
                      ndviP50: round3(info.NDVI_p50),
                      ndviP90: round3(info.NDVI_p90),
                      belowThresholdShare: round3(info.NDVIBELOW_mean),
                      threshold,
                  },
    };
}

/** One Sentinel-2 pass, reduced over a parcel. */
export interface IndexPass {
    /** `YYYY-MM-DD` of the acquisition. */
    date: string;
    /** Field-mean NDVI for this pass, or null when the parcel was fully masked. */
    ndvi: number | null;
    ndmi: number | null;
}

/**
 * Field-mean NDVI/NDMI for EACH cloud-masked pass in the window — #2837.
 *
 * ## One round trip, deliberately
 *
 * The `reduceRegion` happens INSIDE `map`, so it runs server-side per image
 * and the whole series comes back from a single `evaluate`. The obvious
 * alternative — ask `getIndexMeansForPolygon` once per pass — is ~12 round
 * trips for a 60-day window and the same answer. Earth Engine calls are
 * seconds each and metered, which is why `analyzeBlockRisk` already bounds
 * itself to 24 parcels.
 *
 * ## Why this is not `getIndexMeansForPolygon` with a loop
 *
 * That function reduces a `median()` COMPOSITE of the window to one number.
 * The composite is precisely what destroys the per-pass detail the owner asked
 * for, so this cannot be built on it: a trend needs the images kept apart.
 *
 * The masking is identical (the same SCL classes, the same `adaptiveS2Collection`,
 * the same scale 20), so a pass's mean and the composite's mean are comparable
 * rather than two different measurements that happen to share a name.
 *
 * ## Nulls are real answers
 *
 * A pass can be in the collection and still be fully masked over one parcel —
 * cloud over this field, clear over the next. Such a pass returns `null`, not
 * 0: a chart plotting 0 for "we could not see" draws a cliff that never
 * happened.
 */
export async function getIndexMeansPerPass(
    geometry: unknown,
    win: NdviWindow,
    cap: number,
): Promise<IndexPass[]> {
    await initEarthEngine();

    const region = new (ee.Geometry as unknown as { new (g: unknown): EeImage })(geometry);
    // #2837: judge cloud over THIS PARCEL rather than over the ~100x100 km
    // granule — see `PARCEL_TILE_CLOUD_MAX`. Opt-in, so the tile and bounds
    // readers keep their cheaper tile-level filter unchanged.
    const collection = adaptiveS2Collection(region, win, { judgeCloudOverRegion: true });

    const masked = collection.map((img: EeImage) => {
        return img.updateMask(sclClearMask(img));
    });

    const ndviBand = bandFn('ndvi');
    const ndmiBand = bandFn('ndmi');

    const withStats = masked.map((img: EeImage) => {
        const both = (ndviBand(img) as EeImage).addBands(ndmiBand(img)).clip(region);
        const stats = (
            both as unknown as { reduceRegion: (a: Record<string, unknown>) => EeImage }
        ).reduceRegion({
            reducer: ee.Reducer.mean(),
            geometry: region,
            scale: 20,
            maxPixels: 1e9,
            bestEffort: true,
        });
        const imgX = img as unknown as {
            set: (k: string, v: unknown) => EeImage;
            date: () => { format: (f: string) => unknown };
        };
        const statsX = stats as unknown as { get: (k: string) => unknown };
        return imgX
            .set('passDate', imgX.date().format('YYYY-MM-dd'))
            .set('passNdvi', statsX.get('NDVI'))
            .set('passNdmi', statsX.get('NDMI'));
    });

    // `reduceColumns` over the three properties returns ONE list, so the whole
    // series is a single `evaluate`.
    const listed = (
        withStats as unknown as {
            reduceColumns: (r: unknown, cols: string[]) => {
                get: (k: string) => {
                    evaluate: (cb: (v: unknown, err?: unknown) => void) => void;
                };
            };
        }
    )
        .reduceColumns(
            (ee.Reducer as unknown as { toList: (n: number) => unknown }).toList(3),
            ['passDate', 'passNdvi', 'passNdmi'],
        )
        .get('list');

    const rows = await withEeDeadline<unknown[]>(
        'EE per-pass reduceColumns',
        EE_CALL_TIMEOUT_MS,
        (resolve, reject) => {
            listed.evaluate((value: unknown, err?: unknown) => {
                if (err) {
                    reject(new Error(`EE per-pass reduceColumns failed: ${String(err)}`));
                    return;
                }
                resolve(Array.isArray(value) ? value : []);
            });
        },
    );

    const round3 = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;

    const passes: IndexPass[] = [];
    // Sentinel-2 images the same ground from adjacent orbits on consecutive
    // days, and two rows sharing a date would draw two points at one x on the
    // chart. Deduped by date here rather than in EE: it is a handful of rows,
    // and doing it server-side would cost a second grouping for nothing. The
    // FIRST non-null reading for a date wins, so a clear pass is not discarded
    // in favour of a masked one taken hours later.
    const byDate = new Map<string, IndexPass>();
    for (const row of rows) {
        if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
        const date = row[0];
        const pass: IndexPass = { date, ndvi: round3(row[1]), ndmi: round3(row[2]) };
        const seen = byDate.get(date);
        if (!seen || (seen.ndvi === null && pass.ndvi !== null)) byDate.set(date, pass);
    }
    for (const pass of byDate.values()) passes.push(pass);

    // Oldest first: a trend reads left to right, and the caller should not have
    // to sort to draw one.
    passes.sort((a, b) => a.date.localeCompare(b.date));
    return passes.slice(-cap);
}

// Per-index named exports — one per `/agro/<index>-tiles` route. Each is a
// thin wrapper over `getIndexTileUrl` so a route (and its unit test) can
// import + mock a single stable function.
export const getNdviTileUrl = (aoi: NdviAoi, win: NdviWindow, clipGeometry?: unknown): Promise<IndexTileResult> =>
    getIndexTileUrl('ndvi', aoi, win, clipGeometry);
export const getNdmiTileUrl = (aoi: NdviAoi, win: NdviWindow, clipGeometry?: unknown): Promise<IndexTileResult> =>
    getIndexTileUrl('ndmi', aoi, win, clipGeometry);
export const getNdreTileUrl = (aoi: NdviAoi, win: NdviWindow, clipGeometry?: unknown): Promise<IndexTileResult> =>
    getIndexTileUrl('ndre', aoi, win, clipGeometry);
export const getGndviTileUrl = (aoi: NdviAoi, win: NdviWindow, clipGeometry?: unknown): Promise<IndexTileResult> =>
    getIndexTileUrl('gndvi', aoi, win, clipGeometry);
export const getEviTileUrl = (aoi: NdviAoi, win: NdviWindow, clipGeometry?: unknown): Promise<IndexTileResult> =>
    getIndexTileUrl('evi', aoi, win, clipGeometry);
