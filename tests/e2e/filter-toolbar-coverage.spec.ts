/**
 * E2E — FilterToolbar clear-chip round-trip (quality roadmap P4,
 * item 3).
 *
 * `filters.spec.ts` covers the "apply → URL gains the param" path.
 * The clearing path — the user removes an active filter chip and
 * the URL gives the param back — is the genuine gap. This spec
 * pins the round-trip end-to-end.
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

test.describe('FilterToolbar coverage', () => {
    test('applying and clearing a filter chip round-trips through the URL', async ({
        page,
    }) => {
        const tenantSlug = await loginAndGetTenant(page);
        // `OPEN` is a valid farm-tasks `status` filter value
        // (filters.spec.ts uses the same value). A value the page
        // rejects errors the load before the filter chip can render.
        await safeGoto(page, `/t/${tenantSlug}/farm-tasks?status=OPEN`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForLoadState('networkidle').catch(() => {});

        // The URL pre-applied the filter — the page must accept
        // that round-trip without erroring.
        await expect(page).toHaveURL(/[?&]status=OPEN/, {
            timeout: 15_000,
        });

        // Clear via the FilterToolbar's bulk-clear affordance. The
        // chip-internal × buttons drift across the R10 polish rounds;
        // the bulk clear is the structurally stable surface.
        const clearAll = page
            .getByRole('button', { name: /clear filters|clear all/i })
            .first();
        await clearAll.click();

        await expect.poll(() => page.url(), { timeout: 5_000 }).not.toContain(
            'status=OPEN',
        );
    });
});
