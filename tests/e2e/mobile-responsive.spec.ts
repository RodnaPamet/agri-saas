/**
 * Mobile responsive pass — agriculture surfaces (@mobile).
 *
 * READ-ONLY spec: logs in with the shared seeded tenant (DEFAULT_USER →
 * `loginAndGetTenant`), navigates to the locations list and the seeded
 * location detail at a phone viewport, and asserts the responsive
 * contract:
 *
 *   1. No horizontal overflow at the mobile viewport (the classic
 *      "page is wider than the screen" regression) on the list AND
 *      the location-detail Map tab.
 *   2. The location-detail Map tab stacks the map + side panel into a
 *      single column below the `md:` (768px) breakpoint — the grid was
 *      changed from `lg:grid-cols-[1fr_320px]` to `md:` so phones get
 *      a stacked layout. We verify the map sits ABOVE the side panel
 *      (top-to-bottom), not beside it.
 *   3. Key practices remain visible + large enough to tap (the Map-mode
 *      segmented practice is bumped to ≥44px touch targets).
 *
 * This spec is tagged `@mobile` and runs under the mobile device matrix —
 * `mobile-android` (Pixel 5, 393px) + `mobile-iphone` (iPhone 13 viewport,
 * 390px) — both below 768px so the stacking + overflow assertions are
 * meaningful, and both on the Chromium engine (see the engine note in
 * `playwright.config.ts`). The desktop `chromium` project skips it via
 * `grepInvert: /@mobile/`.
 *
 * No mutation, no `data-testid` additions — scoped to existing `id`s,
 * roles, and seeded copy, with locators bound to `getByRole('main')`
 * where a Next streaming duplicate could otherwise match.
 */
import { test, expect, type Page } from '@playwright/test';
import { safeGoto, loginAndGetTenant } from './e2e-utils';

const SEEDED_LOCATION = 'Home Farm — Demo';

/**
 * Assert the document has no horizontal scrollbar at the current
 * viewport — i.e. nothing renders wider than the viewport width.
 * A 1px tolerance absorbs sub-pixel rounding in layout math.
 */
async function expectNoHorizontalOverflow(page: Page, label: string) {
    const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return {
            scrollWidth: doc.scrollWidth,
            clientWidth: doc.clientWidth,
        };
    });
    expect(
        overflow.scrollWidth,
        `${label}: document scrollWidth (${overflow.scrollWidth}) should not exceed viewport clientWidth (${overflow.clientWidth}) — horizontal overflow on mobile`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe('mobile responsive — agriculture @mobile', () => {
    let tenantSlug: string;

    test.beforeEach(async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
    });

    test('locations list fits the mobile viewport with no horizontal scroll', async ({
        page,
    }) => {
        await safeGoto(page, `/t/${tenantSlug}/locations`);

        const main = page.getByRole('main');
        // The list renders a DataTable once data resolves; the page
        // heading is the stable anchor that proves the page painted.
        await expect(
            main.getByRole('heading', { name: 'Locations', level: 1 }),
        ).toBeVisible({ timeout: 30_000 });

        // The seeded field is listed (link into the detail page).
        await expect(
            main.getByRole('link', { name: SEEDED_LOCATION }).first(),
        ).toBeVisible({ timeout: 30_000 });

        await expectNoHorizontalOverflow(page, 'locations list');
    });

    test('location detail Map tab stacks map above the side panel on mobile', async ({
        page,
    }) => {
        // Enter the detail page via the seeded location's row link so we
        // don't hard-code an id.
        await safeGoto(page, `/t/${tenantSlug}/locations`);
        const main = page.getByRole('main');
        const locationLink = main
            .getByRole('link', { name: SEEDED_LOCATION })
            .first();
        await expect(locationLink).toBeVisible({ timeout: 30_000 });
        await locationLink.click();

        // Detail header renders the location name (EntityDetailLayout title).
        await expect(
            main.getByRole('heading', { name: SEEDED_LOCATION }).first(),
        ).toBeVisible({ timeout: 30_000 });

        // Switch to the Map tab (the tab bar is part of EntityDetailLayout).
        await main.getByRole('tab', { name: 'Map' }).click();

        // The Select/Draw/Edit/Split map-mode toggle was removed — the
        // NDVI overlay button now holds that toolbar slot. Touch-target
        // check: it's a ≥44px tap target (WCAG 2.5.5).
        // `exact: true` — the toolbar now also has a GNDVI button, and the
        // default substring match would make `name: 'NDVI'` resolve to both
        // NDVI and G-NDVI (strict-mode violation).
        const ndviButton = main.getByRole('button', { name: 'NDVI', exact: true });
        await expect(ndviButton).toBeVisible({ timeout: 30_000 });
        const ndviBox = await ndviButton.boundingBox();
        expect(ndviBox, 'NDVI practice has a measurable box').not.toBeNull();
        expect(
            ndviBox!.height,
            'NDVI practice should be a ≥44px touch target on mobile',
        ).toBeGreaterThanOrEqual(44);

        // The map container is the labelled, focusable group rendered by
        // MapCanvas.
        const mapRegion = main.getByRole('group', { name: /Parcel map/ });
        await expect(mapRegion).toBeVisible({ timeout: 30_000 });

        // feat/mobile-map: on phones the inline "New spray job" side panel
        // is GONE — the map is full-bleed (the operator's primary screen)
        // and a parcel tap opens a bottom-sheet instead. So the side-panel
        // heading must NOT render on a mobile viewport.
        await expect(
            main.getByRole('heading', { name: 'New spray job' }),
        ).toHaveCount(0);

        // The full-bleed map spans (near) the full viewport width.
        const mapBox = await mapRegion.boundingBox();
        const viewport = page.viewportSize();
        expect(mapBox, 'map region has a box').not.toBeNull();
        expect(viewport, 'viewport size known').not.toBeNull();
        expect(
            mapBox!.width,
            'full-bleed map should span (near) the full viewport width on mobile',
        ).toBeGreaterThanOrEqual(viewport!.width - 4);

        // On-map thumb practices (find-my-field + zoom) render and are 36px
        // practices (above the WCAG 2.5.8 AA 24px minimum; deliberately below
        // the 44px AAA size, which read as oversized on the map).
        const findField = main.getByTestId('map-find-field');
        await expect(findField).toBeVisible({ timeout: 30_000 });
        const findFieldBox = await findField.boundingBox();
        expect(findFieldBox, 'find-field practice has a box').not.toBeNull();
        expect(
            Math.round(findFieldBox!.height),
            'find-my-field should be a ≥36px touch target',
        ).toBeGreaterThanOrEqual(36);

        await expectNoHorizontalOverflow(page, 'location detail — Map tab');
    });
});
