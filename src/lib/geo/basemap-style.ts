import type { StyleSpecification } from 'maplibre-gl';
import { env } from '@/env';

/**
 * Basemap style resolution for `MapCanvas`.
 *
 * EXTRACTED out of MapCanvas so the decision can be asserted by a
 * millisecond unit test rather than a multi-minute MapCanvas render. Before
 * the extraction nothing anywhere executed it: `resolveBasemapStyle`,
 * `DEMO_STYLE` and `demotiles` had exactly one hit across `tests/`, and it was
 * a comment. The rendered MapCanvas suite could not have covered it either —
 * its `Map` stub discards `mapStyle`.
 */

/**
 * Bare outline-only basemap (no imagery). The PRODUCT fallback when no
 * MapTiler key is configured, so the map renders without a signup.
 *
 * Do NOT remove it: #764 is about CI determinism, not about this fallback.
 *
 * Production does NOT currently take this branch — `ghcr-publish.yml` passes
 * `NEXT_PUBLIC_MAPTILER_KEY` as a build-arg from a repo variable, and the key
 * is a populated literal in the deployed bundle's env object, so the deployed
 * map renders from MapTiler. But nothing ASSERTS that: clearing the repo
 * variable, building from a fork, or dropping that one workflow line falls
 * back here silently — a working map quietly served by a third party. See
 * #781. (`Dockerfile`'s `ARG NEXT_PUBLIC_MAPTILER_KEY=""` is the default when
 * nothing supplies one, not the effective value — and note that observing the
 * bundle READ this var proves nothing, since it is read on both branches.)
 */
export const DEMO_STYLE = 'https://demotiles.maplibre.org/style.json';

/** Land tone — the same value `offline-land` paints in offline-basemap-style.ts. */
const FIXTURE_LAND = '#e8ece4';

/**
 * E2E FIXTURE basemap — the degenerate sibling of `buildOfflineBasemapStyle`.
 *
 * That builder REQUIRES a tile template, and the only same-origin template the
 * app has is tenant+location-scoped (`/api/t/<slug>/locations/<id>/basemap/…`).
 * `/field/[taskId]` and `/farm-tasks/[taskId]` mount a map with no location id,
 * so it cannot serve the general case. This one drops the vector source
 * entirely and paints the land tone flat.
 *
 * Returned INLINE as an object rather than as a URL: `mapStyle` accepts
 * `StyleSpecification | string` and the offline branch already passes an
 * object, so this needs no new shape — and an inline style makes ZERO
 * requests, which is strictly stronger than "same-origin requests". There is
 * no file under `public/`, no route, and nothing to keep in sync.
 *
 * Measured (maplibre-gl 6.6.0, headless chromium): `styledata` → `load` →
 * `idle`, `isStyleLoaded()` true, canvas visible, zero error events, zero
 * requests. `validateStyleMin` returns `[]` — asserted in the unit test,
 * because MapCanvas registers no `onError` and an invalid style would
 * otherwise fail silently.
 */
export function buildFixtureBasemapStyle(): StyleSpecification {
    return {
        version: 8,
        name: 'E2E fixture basemap',
        sources: {},
        layers: [
            {
                id: 'fixture-background',
                type: 'background',
                paint: { 'background-color': FIXTURE_LAND },
            },
        ],
    };
}

/**
 * Resolve the basemap style. Precedence, and the order is load-bearing:
 *
 *   1. the E2E fixture (inline, network-free) — FIRST, so a runner that
 *      happens to carry a MapTiler key still stays hermetic;
 *   2. MapTiler when a key is configured (referrer-restricted in the MapTiler
 *      dashboard — it is fetched in the browser, so necessarily public);
 *   3. the keyless demo fallback.
 *
 * The `?? 'hybrid'` is load-bearing rather than defensive.
 * `NEXT_PUBLIC_MAP_BASEMAP_STYLE` carries a zod `.default('hybrid')` that
 * fires under NEITHER `SKIP_ENV_VALIDATION=1` (env-core returns `runtimeEnv`
 * verbatim) NOR the jest env mock — so without it, a key-set/style-unset
 * deploy resolves to `maps/undefined/style.json`. The unit test pins that
 * case.
 */
export function resolveBasemapStyle(): string | StyleSpecification {
    if (env.NEXT_PUBLIC_MAP_BASEMAP_FIXTURE === '1') return buildFixtureBasemapStyle();
    const key = env.NEXT_PUBLIC_MAPTILER_KEY;
    if (!key) return DEMO_STYLE;
    const style = env.NEXT_PUBLIC_MAP_BASEMAP_STYLE ?? 'hybrid';
    return `https://api.maptiler.com/maps/${style}/style.json?key=${key}`;
}
