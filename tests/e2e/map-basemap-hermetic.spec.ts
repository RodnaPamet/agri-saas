/**
 * Basemap hermeticity — the operator map must reach no third-party origin.
 *
 * ISOLATED / MUTATING tenant (e2e-isolation convention). Seeds its OWN
 * location + parcel via the authenticated API.
 *
 * ── Why this spec exists, and why it is a SPEC and not a guard ────────────
 *
 * #764: every E2E run that mounted a map fetched `demotiles.maplibre.org` —
 * `style.json`, then `tiles/tiles.json`, then `.pbf` tiles, then
 * `font/{fontstack}/{range}.pbf` for the style's two symbol layers. That
 * dependency already failed on GitHub runners; it was harmless only because
 * the specs it failed under assert nothing about the basemap.
 *
 * The obvious enforcement — blackhole the CDN and let the map specs go red —
 * DOES NOT WORK, measured rather than assumed:
 *
 *   • `canvas.maplibregl-canvas` is created synchronously in the MapLibre Map
 *     constructor, BEFORE any style request, so it is visible whether or not
 *     the style ever loads;
 *   • the controls the map specs interact with are React siblings of `<Map>`,
 *     not children of the rendered basemap;
 *   • `ag-map-visual.spec.ts` only attaches its screenshot — nothing compares
 *     it;
 *   • nothing in the suite asserts on console output (`e2e-utils.ts` logs
 *     browser errors and explicitly suppresses `Failed to load resource`).
 *
 * So a blocked basemap leaves the whole suite GREEN. The `/etc/hosts`
 * blackhole in `ci.yml` is belt-and-braces and a standing proof for a
 * sceptic; it is NOT the detector. THIS is the detector: it observes the
 * requests the page actually makes and fails naming the URL.
 *
 * A structural guard could not do this job either — "no request left
 * localhost" is a runtime fact, and CLAUDE.md is explicit that a guard
 * asserting on source text contributes zero runtime coverage.
 *
 * Deliberately NOT `@mobile`-tagged, so it runs on the desktop `chromium`
 * project — the surface `tests/e2e/mobile/map.spec.ts` never covers.
 */
import { test, expect } from './fixtures';
import { waitForFieldMapWarm } from './e2e-utils';

const SQUARE = {
    type: 'Polygon' as const,
    coordinates: [[[25.0, 42.0], [25.0, 42.01], [25.01, 42.01], [25.01, 42.0], [25.0, 42.0]]],
};

/**
 * Third-party origins the suite still reaches, each with a written reason and
 * a tracking issue. An ALLOWLIST, not a denylist: a NEW external origin fails
 * this spec until somebody decides it is acceptable — which is the property
 * that keeps #764 from recurring through a different door.
 *
 * Every entry here is a known gap, not an endorsement. The suite is
 * demotiles-hermetic; it is not hermetic.
 */
const ALLOWED_EXTERNAL = new Map<string, string>([
    ['fonts.googleapis.com', 'src/app/globals.css:6 remote @import — must stay an @import (#779)'],
    ['fonts.gstatic.com', 'font files pulled by the above (#779)'],
]);

test.describe('basemap hermeticity', () => {
    test.describe.configure({ retries: 0 });

    test('the operator map reaches no third-party origin', async ({ authedPage, isolatedTenant }) => {
        test.setTimeout(120_000);
        const page = authedPage;
        const slug = isolatedTenant.tenantSlug;
        const api = page.request;

        // ── Observers first: a request made before we listen is a request we
        //    would report as absent. ────────────────────────────────────────
        const external: string[] = [];
        page.on('request', (req) => {
            let host: string;
            try {
                host = new URL(req.url()).hostname;
            } catch {
                return; // blob: / data: — no host, never a network hop
            }
            if (!host || host === 'localhost' || host === '127.0.0.1') return;
            if (ALLOWED_EXTERNAL.has(host)) return;
            external.push(`${req.method()} ${req.url()}`);
        });

        // A style MapLibre fetched but could not parse would satisfy the
        // request assertion trivially, so watch for its loader errors too.
        const styleErrors: string[] = [];
        page.on('console', (m) => {
            if (m.type() !== 'error') return;
            const text = m.text();
            if (text.includes('AJAXError') || text.includes('demotiles')) styleErrors.push(text);
        });

        // ── Seed a location + parcel so the map has geometry to draw ──────
        const locRes = await api.post(`/api/t/${slug}/locations`, { data: { name: 'Home Farm' } });
        expect(locRes.ok(), `create location: ${locRes.status()}`).toBeTruthy();
        const locationId = (await locRes.json()).id as string;

        const parRes = await api.post(`/api/t/${slug}/locations/${locationId}/parcels`, {
            data: { name: 'North 40', cropType: 'Wheat', geometry: SQUARE },
        });
        expect(parRes.ok(), `create parcel: ${parRes.status()}`).toBeTruthy();

        // ── Render the real map ──────────────────────────────────────────
        await page.goto(`/t/${slug}/locations/${locationId}`);
        const main = page.getByRole('main');
        await expect(
            main.getByRole('heading', { name: 'Home Farm' }).first(),
        ).toBeVisible({ timeout: 30_000 });

        await main.getByRole('tab', { name: 'Map' }).click();
        await waitForFieldMapWarm(page);
        await expect(page.locator('canvas.maplibregl-canvas').first()).toBeVisible({
            timeout: 30_000,
        });
        // Waiting on the parcel label gives MapLibre time to resolve its style
        // and issue any tile/glyph fetch — without this the assertions below
        // could pass simply because nothing had happened yet.
        await expect(main.getByText('North 40').first()).toBeVisible({ timeout: 30_000 });

        expect(
            external,
            'the map must reach no third-party origin — see ALLOWED_EXTERNAL for the known gaps',
        ).toEqual([]);
        expect(
            styleErrors,
            'the basemap style must load without a maplibre AJAXError',
        ).toEqual([]);

        // ── Soil view: the SECOND origin (#782) ──────────────────────────
        //
        // Dropping `maps.isric.org` from ALLOWED_EXTERNAL proves nothing on
        // its own — the entry's own comment said the origin was "unreached
        // unless Soil view is on", and no spec turned it on. So the removal is
        // only meaningful together with this: turn it on, and assert the
        // request list is STILL empty.
        //
        // `exact: true` because Playwright matches an accessible name as a
        // case-insensitive substring by default, and a bare 'Soil' would also
        // match any other control whose name merely contains it.
        await main.getByRole('button', { name: 'Soil', exact: true }).click();

        // The soil raster and its legend are both same-origin proxies now, so
        // wait for the legend image to actually load rather than for a fixed
        // delay — otherwise the assertion below could pass because nothing had
        // been requested yet, which is the failure mode this whole spec exists
        // to avoid.
        // Pinned to the legend's own alt text (`ag.map.canvas.soilLegendAlt`),
        // not a bare `img` — the page carries other images, and `.first()` on
        // a loose locator would resolve to one of those and wait for nothing.
        // Safe to spell in English: this suite runs in the default locale.
        await expect(
            page.locator('img[alt="Soil class legend"]'),
        ).toBeVisible({ timeout: 30_000 });

        expect(
            external,
            'Soil view must reach no third-party origin either — #782 removed maps.isric.org',
        ).toEqual([]);
    });
});
