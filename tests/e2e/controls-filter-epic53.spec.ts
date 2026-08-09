import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

/**
 * Epic 53 E2E — Practices page on the new enterprise filter system.
 *
 * Exercises the observable migration contract:
 *   1. The consolidated FilterSelect picker opens, drills into a filter, and
 *      applies a value that lands in the URL.
 *   2. Empty-state copy renders when a filter matches nothing.
 *
 * NOTE: R14 (#443) removed the free-text `#practice-search` input from
 * every list page — the navbar ⌘K palette is the sole search affordance
 * now. The two search-driven tests that used to live here (q-param write,
 * clear-search) were deleted; the FilterSelect popover is the surviving
 * filter UI.
 *
 * Tenant safety: we read/assert URLs scoped under `/t/{slug}/practices` and
 * exercise real API calls — no filter-state mocking.
 */

test.describe('Practices — Epic 53 filter system', () => {
    test.describe.configure({ mode: 'serial' });

    let tenantSlug: string;

    test('FilterSelect trigger opens the command palette', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/practices`);
        await page.waitForLoadState('networkidle').catch(() => {});

        // The shared FilterSelect renders a button labelled "Filter". Click the
        // first matching button to open the picker.
        const trigger = page.getByRole('button', { name: /filter/i }).first();
        await expect(trigger).toBeVisible({ timeout: 10000 });
        await trigger.click();

        // cmdk renders its list with role="listbox". The picker should now
        // present a list of top-level filter categories (Status, Applicability,
        // Owner, Category).
        await expect(page.getByRole('listbox').first()).toBeVisible({ timeout: 10000 });
    });

    test('picking a status filter pushes it into the URL', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/practices`);
        await page.waitForLoadState('networkidle').catch(() => {});

        await page.getByRole('button', { name: /filter/i }).first().click();
        await expect(page.getByRole('listbox').first()).toBeVisible({ timeout: 10000 });

        // Drill into Status — scope to the cmdk listbox so the lookup
        // doesn't collide with the inline <select> status pills on
        // every practice row (which expose `<option>Implemented</option>`
        // accessible names).
        const filterListbox = page.getByLabel('Suggestions');
        const statusRow = filterListbox.getByRole('option', { name: /^Status$/ });
        await statusRow.waitFor({ state: 'visible', timeout: 5000 });
        await statusRow.click();

        // Pick "Implemented"
        const implemented = filterListbox.getByRole('option', { name: /Implemented/ });
        await implemented.waitFor({ state: 'visible', timeout: 5000 });
        await implemented.click();

        // URL should now carry status=IMPLEMENTED.
        await expect(page).toHaveURL(/[?&]status=IMPLEMENTED/, { timeout: 10000 });
    });
});
