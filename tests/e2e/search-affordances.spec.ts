/**
 * E2E — search affordances (2026-05-30).
 *
 * Free-text search lives INSIDE the filter dropdown — there is NO
 * separate search bar on the page. Opening the Filter popover and typing
 * in its top input filters the table live (commits `q` to the URL, no
 * Enter). The global ⌘K palette remains the cross-entity search.
 *
 * GRC teardown phase 2 — this drove `/practices` as the representative
 * list page. The contract is a PLATFORM one (FilterToolbar's
 * `searchId` + `searchPlaceholder` turn the popover's top input into a
 * live content search, and `useFilterContext` pushes `q` into the URL),
 * so it is re-pointed at `/assets` — which wires `searchId="assets-search"`
 * the same way and is seeded — rather than deleted.
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

test.describe('Search affordances', () => {
    test('assets search lives inside the filter dropdown; ⌘K still opens', async ({
        page,
    }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/assets`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForLoadState('networkidle').catch(() => {});

        const main = page.getByRole('main');

        // No standalone search bar on the page.
        await expect(main.locator('input[type="search"]')).toHaveCount(0);

        // Open the Filter dropdown — the live content search lives within.
        await main.locator('[data-filter-trigger]').first().click();
        const search = page.locator('#assets-search input');
        await expect(search).toBeVisible();

        // Typing filters the table live — the query lands in the URL with
        // no Enter press. "deere" matches the seeded John Deere tractor.
        await search.fill('deere');
        await expect(page).toHaveURL(/[?&]q=deere/, { timeout: 5000 });

        // Close the dropdown, then confirm ⌘K still opens the palette.
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+KeyK');
        await expect(
            page.locator('[data-testid="command-palette-input"]'),
        ).toBeVisible({ timeout: 5000 });
    });
});
