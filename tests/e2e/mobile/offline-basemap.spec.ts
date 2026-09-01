/**
 * Mobile offline basemap pack — phone-native offline map (@mobile).
 *
 * ISOLATED / MUTATING tenant (e2e-isolation convention). Seeds its OWN
 * location + parcel via the authenticated API.
 *
 * Proves the Roadmap-6 P1b contract at a phone viewport: an installed field
 * user pre-downloads a location's bounded basemap pack, and afterwards — with
 * NO signal — the operator map still renders their parcels on a real backdrop
 * instead of a blank void.
 *
 *   1. Load the field's Map tab online (the service worker registers +
 *      practices the page after a reload).
 *   2. Tap "Download offline map" → the bounded, same-origin basemap tiles
 *      are fetched and the SW stores them in its dedicated basemap cache. The
 *      toast confirms only that the requests COMPLETED, not that anything was
 *      cached (#780); the tile assertion below is what proves that.
 *   3. Go OFFLINE. A basemap tile fetched in-page still resolves (served from
 *      the SW's basemap cache), the MapLibre canvas is visible, and the
 *      parcel label renders — the map is NOT a blank void offline.
 *
 * Runs under the mobile device matrix. retries:0 + a per-test cap keep it
 * fast + cheap.
 */
import { test, expect } from '../fixtures';

// A small valid WGS84 square (mirrors map.spec.ts) so the location gets a bbox.
const SQUARE = {
    type: 'Polygon' as const,
    coordinates: [[[25.0, 42.0], [25.0, 42.01], [25.01, 42.01], [25.01, 42.0], [25.0, 42.0]]],
};

test.describe('mobile offline basemap pack @mobile', () => {
    test.describe.configure({ retries: 0 });

    test('download → the field map renders parcels + basemap offline (no blank void)', async ({
        authedPage,
        isolatedTenant,
    }) => {
        test.setTimeout(120_000);
        const page = authedPage;
        const slug = isolatedTenant.tenantSlug;
        const api = page.request; // cookie-authenticated after signInAs

        // ── Seed a location + one parcel (gives the location a bbox) ──────
        const locRes = await api.post(`/api/t/${slug}/locations`, { data: { name: 'Home Farm' } });
        expect(locRes.ok(), `create location: ${locRes.status()}`).toBeTruthy();
        const locationId = (await locRes.json()).id as string;

        const parRes = await api.post(`/api/t/${slug}/locations/${locationId}/parcels`, {
            data: { name: 'North 40', cropType: 'Wheat', geometry: SQUARE },
        });
        expect(parRes.ok(), `create parcel: ${parRes.status()}`).toBeTruthy();

        // ── Open the page so the service worker registers, then reload so it
        //    CONTROLS the page (an uncontrolled first load wouldn't route the
        //    tile fetches through the SW → nothing would be cached). ────────
        await page.goto(`/t/${slug}/locations/${locationId}`);
        await page.evaluate(async () => {
            if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;
        });
        await page.reload();
        await page.evaluate(async () => {
            if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;
        });

        const main = page.getByRole('main');
        await expect(
            main.getByRole('heading', { name: 'Home Farm' }).first(),
        ).toBeVisible({ timeout: 30_000 });

        // ── Map tab → the MapLibre canvas mounts ─────────────────────────
        await main.getByRole('tab', { name: 'Map' }).click();
        const canvas = page.locator('canvas.maplibregl-canvas').first();
        await expect(canvas).toBeVisible({ timeout: 30_000 });

        // ── Download the bounded offline basemap pack ────────────────────
        const download = page.locator('#download-offline-map-btn');
        await expect(download).toBeVisible({ timeout: 15_000 });
        await download.click();
        // The toast confirms the requests completed — NOT that a tile was
        // cached. The button counts a 204 as success
        // (DownloadBasemapButton.tsx:68-69, #780) and the proxy soft-fails to
        // 204 when its upstream is unreachable, so an all-204 pack still
        // shows this toast over an empty cache.
        await expect(page.getByText('Offline map saved', { exact: false })).toBeVisible({
            timeout: 30_000,
        });

        // ── The SERVER half of #764, observed ─────────────────────────────
        // `page.request` bypasses the service worker, so this reaches the Next
        // server directly. `X-Basemap-Source` is the ONLY signal that tells
        // "the fixture is wired" apart from "the fixture is NOT wired but the
        // CDN happened to be up" — from the client the two are identical.
        // Playwright cannot intercept that fetch (it runs in the Node
        // process), so this header is how the server half is proven at all.
        const tileRes = await api.get(
            `/api/t/${slug}/locations/${locationId}/basemap/0/0/0`,
        );
        expect(tileRes.status(), 'z0 pack tile').toBe(200);
        expect(
            tileRes.headers()['x-basemap-source'],
            'served from the E2E fixture, not a third-party CDN',
        ).toBe('fixture');
        expect((await tileRes.body()).byteLength).toBeGreaterThan(0);

        // ── Go OFFLINE and prove the pack is served from the SW cache ─────
        await page.context().setOffline(true);

        // A basemap tile fetched in-page must STILL resolve offline — it is
        // served from the SW's dedicated basemap cache. This is the direct
        // proof the pack works with no signal (z0 always covers any bbox).
        // Asserts BYTES, not merely a resolved response. `res.ok` accepted a
        // 204 — which carries no body and which `public/sw.js:285` refuses to
        // cache — so this probe used to pass against a completely EMPTY pack.
        // A deterministic upstream is what finally makes the strict form
        // possible.
        const tileBytes = await page.evaluate(async (u) => {
            try {
                const res = await fetch(u, { credentials: 'same-origin' });
                if (res.status !== 200) return -1;
                return (await res.arrayBuffer()).byteLength;
            } catch {
                return -1;
            }
        }, `/api/t/${slug}/locations/${locationId}/basemap/0/0/0`);
        expect(tileBytes, 'basemap tile served from SW cache while offline').toBeGreaterThan(0);

        // The map is not a blank void: the canvas is still there and the
        // parcel label renders (parcels come from the field-data cache).
        await expect(canvas).toBeVisible();
        await expect(main.getByText('North 40').first()).toBeVisible({ timeout: 15_000 });

        await page.context().setOffline(false);
    });
});
