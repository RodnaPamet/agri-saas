/**
 * E2E — search affordances (2026-05-30).
 *
 * Free-text search lives INSIDE the filter dropdown — there is NO
 * separate search bar on the page. Opening the Filter popover and typing
 * in its top input filters the table live (commits `q` to the URL, no
 * Enter). The global ⌘K palette remains the cross-entity search.
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

test.describe('Search affordances', () => {
    test('practices search lives inside the filter dropdown; ⌘K still opens', async ({
        page,
    }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/practices`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForLoadState('networkidle').catch(() => {});

        const main = page.getByRole('main');

        // No standalone search bar on the page.
        await expect(main.locator('input[type="search"]')).toHaveCount(0);

        // Open the Filter dropdown — the live content search lives within.
        await main.locator('[data-filter-trigger]').first().click();
        const search = page.locator('#practices-search input');
        await expect(search).toBeVisible();

        // Typing filters the table live — the query lands in the URL with
        // no Enter press.
        await search.fill('iso');
        await expect(page).toHaveURL(/[?&]q=iso/, { timeout: 5000 });

        // Close the dropdown, then confirm ⌘K still opens the palette.
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+KeyK');
        await expect(
            page.locator('[data-testid="command-palette-input"]'),
        ).toBeVisible({ timeout: 5000 });
    });
});
