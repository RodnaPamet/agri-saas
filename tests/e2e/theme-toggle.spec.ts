/**
 * Epic 51 — light-mode activation smoke test.
 *
 * The light-mode tokens have been live since the Epic 51 finishing
 * pass. This test pins the round-trip:
 *
 *   1. First visit paints the dark theme (our SSR default).
 *   2. Invoking "Toggle theme" from the command palette flips
 *      `html[data-theme]` to "light" and persists the choice to
 *      localStorage.
 *   3. Reloading the page restores the persisted theme instead of
 *      falling back to `prefers-color-scheme`.
 *
 * The sidebar theme-toggle icon was retired in R13 — toggling now
 * lives in the command palette (`action:toggle-theme`), reachable
 * via the inline Search button in the sidebar footer or ⌘K.
 *
 * Visual regression (screenshot per page) is handled by the richer
 * Playwright runs; here we just verify the wiring.
 */

import { test, expect } from '@playwright/test';
import {
    createIsolatedTenant,
    safeGoto,
    signInAs,
    type IsolatedTenantCredentials,
} from './e2e-utils';

test.describe('Epic 51 — theme toggle', () => {
    // GAP-23: provision a dedicated tenant per describe block so the
    // theme-toggle test doesn't contend with parallel suites' UI state
    // on the seeded acme-corp tenant. The tenant + owner are
    // hard-deleted in the global teardown.
    let tenant: IsolatedTenantCredentials;

    test.beforeAll(async ({ request }) => {
        tenant = await createIsolatedTenant({
            request,
            namePrefix: 'theme',
        });
    });

    test('cycles html[data-theme] dark → light → sunlight → dark and persists across reload', async ({
        page,
    }) => {
        // Pin the starting theme to dark regardless of the chromium
        // default `prefers-color-scheme` (Playwright emulates it as
        // "light" on this host). Only set the key when it's not
        // already present so a later toggle to "light" doesn't get
        // overwritten by the initScript on page reload.
        await page.context().addInitScript(() => {
            try {
                if (!window.localStorage.getItem('inflect:theme')) {
                    window.localStorage.setItem('inflect:theme', 'dark');
                }
            } catch {
                /* storage not available; fall through to SSR default */
            }
        });

        const tenantSlug = await signInAs(page, tenant);

        await safeGoto(page, `/t/${tenantSlug}/dashboard`, {
            waitUntil: 'domcontentloaded',
        });

        // SSR baseline is dark. Asserted through an auto-waiting matcher
        // rather than `page.evaluate` + `toBe`: the evaluate is an instant
        // read, which is what made the `networkidle` above it load-bearing.
        // The attribute is server-rendered, so this resolves immediately.
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark', {
            timeout: 15_000,
        });

        // Open the command palette (the sidebar footer's inline
        // Search button is the desktop opener; the same affordance
        // is hooked to ⌘K). Then run the "Toggle theme" action.
        const flipTheme = async () => {
            const opener = page
                .getByRole('complementary')
                .locator('[data-testid="sidebar-search-anchor"]');
            await opener.waitFor({ state: 'visible', timeout: 30_000 });
            await opener.click();
            const action = page.locator(
                '[data-testid="command-palette-action-action:toggle-theme"]',
            );
            await action.waitFor({ state: 'visible', timeout: 10_000 });
            await action.click();
        };

        await flipTheme();

        await expect
            .poll(() =>
                page.evaluate(() => document.documentElement.dataset.theme),
            )
            .toBe('light');

        // Persistence: the toggle writes to localStorage.
        const stored = await page.evaluate(() =>
            window.localStorage.getItem('inflect:theme'),
        );
        expect(stored).toBe('light');

        // Reload and confirm the stored theme is restored rather than
        // falling back to prefers-color-scheme.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect
            .poll(() =>
                page.evaluate(() => document.documentElement.dataset.theme),
            )
            .toBe('light');

        // Second flip → sunlight. The high-contrast outdoor mode is the light
        // palette PLUS a data-contrast="high" overlay, so data-theme stays
        // "light" and data-contrast becomes "high".
        await flipTheme();
        await expect
            .poll(() =>
                page.evaluate(() => document.documentElement.dataset.contrast ?? null),
            )
            .toBe('high');
        await expect
            .poll(() =>
                page.evaluate(() => document.documentElement.dataset.theme),
            )
            .toBe('light');

        // Third flip → back to dark (cycle complete; data-contrast cleared) —
        // leaves the environment in the state other tests expect.
        await flipTheme();
        await expect
            .poll(() =>
                page.evaluate(() => document.documentElement.dataset.theme),
            )
            .toBe('dark');
        await expect
            .poll(() =>
                page.evaluate(() => document.documentElement.dataset.contrast ?? null),
            )
            .toBe(null);
    });
});
