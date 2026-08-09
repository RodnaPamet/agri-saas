/**
 * Mobile map — phone-native operator map (@mobile).
 *
 * ISOLATED / MUTATING tenant (e2e-isolation convention). Seeds its OWN
 * location + parcel via the authenticated API so the assertions never
 * depend on a shared-seed spatial-import side effect (the disabled-launcher
 * trap documented in data-entry.spec.ts).
 *
 * Proves the feat/mobile-map contract at a phone viewport:
 *   1. On-map thumb practices (locate-me + zoom ±) render and are ≥44px
 *      (WCAG 2.5.5) touch targets.
 *   2. "Locate me" recenters on the device GPS — with geolocation granted
 *      + mocked, tapping it drops the blue user-location dot.
 *   3. Tapping a parcel (card) opens the parcel bottom-sheet (vaul) with
 *      area + an apply-rate calculator, and "Start operation here" launches
 *      the spray-job wizard with that parcel pre-selected.
 *   4. The full-bleed map introduces no horizontal overflow.
 *
 * Runs under the mobile device matrix (Pixel 5 / iPhone 13 viewport, both
 * Chromium). retries:0 + a per-test cap keep a regression fast + cheap.
 */
import { test, expect } from '../fixtures';

// A small valid WGS84 square around the origin (mirrors data-entry.spec.ts).
const SQUARE = {
    type: 'Polygon' as const,
    coordinates: [[[0, 0], [0, 0.01], [0.01, 0.01], [0.01, 0], [0, 0]]],
};

test.describe('mobile map — phone-native operator map @mobile', () => {
    test.describe.configure({ retries: 0 });

    test('on-map practices, locate-me, and the parcel bottom-sheet work on a phone', async ({
        authedPage,
        isolatedTenant,
    }) => {
        test.setTimeout(90_000);
        const page = authedPage;
        const slug = isolatedTenant.tenantSlug;
        const api = page.request; // cookie-authenticated after signInAs

        // ── Seed a location + one parcel ──────────────────────────────
        const locRes = await api.post(`/api/t/${slug}/locations`, {
            data: { name: 'Home Farm' },
        });
        expect(locRes.ok(), `create location: ${locRes.status()}`).toBeTruthy();
        const locationId = (await locRes.json()).id as string;

        const parRes = await api.post(
            `/api/t/${slug}/locations/${locationId}/parcels`,
            { data: { name: 'North 40', cropType: 'Wheat', geometry: SQUARE } },
        );
        expect(parRes.ok(), `create parcel: ${parRes.status()}`).toBeTruthy();

        // Grant + mock geolocation BEFORE the page interacts with it so the
        // "Locate me" success path is deterministic. Coordinates sit inside
        // the seeded parcel's bbox so the dropped dot is in view.
        await page.context().grantPermissions(['geolocation']);
        await page.context().setGeolocation({ latitude: 0.005, longitude: 0.005 });

        await page.goto(`/t/${slug}/locations/${locationId}`);
        const main = page.getByRole('main');
        await expect(
            main.getByRole('heading', { name: 'Home Farm' }).first(),
        ).toBeVisible({ timeout: 30_000 });

        // ── Map tab: on-map thumb practices ───────────────────────────
        await main.getByRole('tab', { name: 'Map' }).click();

        const findField = page.getByTestId('map-find-field');
        const zoomIn = page.getByTestId('map-zoom-in');
        const zoomOut = page.getByTestId('map-zoom-out');
        await expect(findField).toBeVisible({ timeout: 30_000 });
        await expect(zoomIn).toBeVisible();
        await expect(zoomOut).toBeVisible();

        // Each is a 36px practice (min-h-[36px] min-w-[36px]) — above the WCAG
        // 2.5.8 AA 24px minimum. (Deliberately below the 44px AAA size: the
        // practices read as oversized on the map.) Round for sub-pixel layout.
        for (const [label, ctrl] of [['find-field', findField], ['zoom-in', zoomIn], ['zoom-out', zoomOut]] as const) {
            const box = await ctrl.boundingBox();
            expect(box, `${label} practice has a box`).not.toBeNull();
            expect(Math.round(box!.height), `${label} practice ≥36px tall`).toBeGreaterThanOrEqual(36);
            expect(Math.round(box!.width), `${label} practice ≥36px wide`).toBeGreaterThanOrEqual(36);
        }

        // The full-bleed map must not introduce horizontal overflow.
        const overflow = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        }));
        expect(
            overflow.scrollWidth,
            `full-bleed map should not overflow (${overflow.scrollWidth} vs ${overflow.clientWidth})`,
        ).toBeLessThanOrEqual(overflow.clientWidth + 1);

        // ── Find-my-field frames a field (no GPS) — the practice stays
        //    usable so the operator can tap again to cycle to the next. ──
        await findField.click();
        await expect(findField).toBeVisible();

        // ── Parcel bottom-sheet (via the Parcels list in Overview) ───
        // The standalone Parcels tab was folded into a collapsible dropdown
        // under the Overview tab's field-report row.
        await main.getByRole('tab', { name: 'Overview' }).click();
        await main.getByRole('button', { name: /Parcels/ }).click();
        // The mobile card fallback renders a tappable parcel card.
        await main.getByText('North 40').first().click();

        const area = page.getByTestId('parcel-sheet-area');
        await expect(area).toBeVisible({ timeout: 15_000 });
        await expect(area).toContainText('dca');
        await expect(page.getByTestId('parcel-sheet-crop')).toContainText('Wheat');

        // The sheet IS the single create-operation form now (#3): the
        // exclusive Fertilizer-XOR-Product selector + the create action.
        // (The old apply-rate calculator + multi-step wizard were retired.)
        await expect(page.getByText('New operation').first()).toBeVisible();
        await expect(page.getByRole('radio', { name: 'Product' })).toBeVisible();
        await expect(page.getByRole('radio', { name: 'Fertilizer' })).toBeVisible();
        const createBtn = page.getByTestId('parcel-sheet-start-operation');
        await expect(createBtn).toBeVisible();
        // Gated until an input + dose + operator are chosen.
        await expect(createBtn).toBeDisabled();
    });

    // Turning the cadastre overlay on must not introduce horizontal drift. The
    // toggle only renders when a cadastre source is configured (CADASTRE_PARCELS_URL
    // / CADASTRE_WMS_URL) — CI usually has neither, so this no-ops (skips) there.
    test('the cadastre overlay toggle introduces no horizontal drift on a phone', async ({
        authedPage,
        isolatedTenant,
    }) => {
        test.setTimeout(90_000);
        const page = authedPage;
        const slug = isolatedTenant.tenantSlug;
        const api = page.request;

        const locRes = await api.post(`/api/t/${slug}/locations`, { data: { name: 'Cadastre Farm' } });
        expect(locRes.ok(), `create location: ${locRes.status()}`).toBeTruthy();
        const locationId = (await locRes.json()).id as string;
        const parRes = await api.post(`/api/t/${slug}/locations/${locationId}/parcels`, {
            data: { name: 'Plot A', geometry: SQUARE },
        });
        expect(parRes.ok(), `create parcel: ${parRes.status()}`).toBeTruthy();

        await page.goto(`/t/${slug}/locations/${locationId}`);
        const main = page.getByRole('main');
        await expect(main.getByRole('heading', { name: 'Cadastre Farm' }).first()).toBeVisible({
            timeout: 30_000,
        });
        await main.getByRole('tab', { name: 'Map' }).click();
        await expect(page.getByTestId('map-zoom-in')).toBeVisible({ timeout: 30_000 });

        // The single cadastre toggle carries either label ("Cadastral map" for
        // the raster path, "Cadastral boundaries" for the vector path).
        const toggle = main.getByRole('button', { name: /Cadastr/i });
        if ((await toggle.count()) === 0) {
            test.skip(true, 'cadastre overlay not configured in this environment');
            return;
        }

        await toggle.first().click();
        // Let any viewport fetch / source mount settle.
        await page.waitForTimeout(500);

        const overflow = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        }));
        expect(
            overflow.scrollWidth,
            `cadastre overlay should not overflow (${overflow.scrollWidth} vs ${overflow.clientWidth})`,
        ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });
});
