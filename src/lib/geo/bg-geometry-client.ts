/**
 * One fetch of `public/geo/bg-map-geometry.json` per page load.
 *
 * The file carries the national projection parameters plus 28 oblast
 * outlines and a 5 KB country path. `ExchangeMap` fetches it straight
 * from an effect with no caching of any kind, which is survivable while
 * exactly one component wants it. It is not survivable once a second
 * canvas on a different page wants it too: a farmer on rural LTE would
 * pay for the same 100 KB twice, on a page whose entire reason for
 * existing is to make a big holding cheap to look at.
 *
 * A module-level promise is the whole mechanism — the second caller
 * awaits the first caller's request. A rejection clears the cache so a
 * later mount can retry rather than inheriting a permanent failure.
 *
 * Deliberately NOT a static import: bundling the geometry would put 100
 * KB of oblast path strings into the page's JS payload, where the browser
 * cannot cache it separately from the code around it.
 */

import type { BgMapGeometry } from './bg-projection';

let inFlight: Promise<BgMapGeometry> | null = null;

export function loadBgMapGeometry(): Promise<BgMapGeometry> {
    inFlight ??= fetch('/geo/bg-map-geometry.json')
        .then((r) => (r.ok ? (r.json() as Promise<BgMapGeometry>) : Promise.reject(new Error(String(r.status)))))
        .catch((err: unknown) => {
            inFlight = null;
            throw err;
        });
    return inFlight;
}

/** Test seam: drop the memo so each case starts from a cold cache. */
export function resetBgMapGeometryCache(): void {
    inFlight = null;
}
