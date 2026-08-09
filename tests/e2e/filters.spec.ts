import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

/**
 * FilterToolbar contract — Tasks (farm-tasks) and Vendors.
 *
 * The Practices page has its own canonical coverage in
 * `practices-filter-epic53.spec.ts`. This spec extends that contract to
 * the two other migrated list pages (the farm-tasks queue, Vendors).
 *
 * The pre-Epic-53 version of this file exercised the deprecated
 * `CompactFilterBar` DOM (`filter-dd-status`, `filter-chip-overdue`,
 * etc.). The shared `FilterToolbar` aggregates every filter behind a
 * single popover, so the tests below drive the actual UI:
 *
 *   1. Click the trigger → the cmdk listbox appears.
 *   2. Click the top-level filter (e.g. "Status") → value options appear.
 *   3. Click a value → the URL picks up the param.
 *
 * The farm-tasks queue exposes the manager-relevant filter subset
 * (status · assignee · due); the compliance-only type / severity axes
 * were retired with the /tasks list.
 *
 * NOTE: R14 (#443) removed the free-text search input from every list
 * page — the per-page `search input writes q param` tests and the
 * `URL persistence` block (both driven by `#task-search` / `#vendor-search`
 * / `#practice-search`) were deleted. The navbar ⌘K palette is the sole
 * search affordance now.
 */

test.describe('FilterToolbar — Tasks', () => {
    test.describe.configure({ mode: 'serial' });

    let tenantSlug: string;

    test('picking a status filter pushes it into the URL', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/farm-tasks`);
        await page.waitForLoadState('networkidle').catch(() => {});

        await page.getByRole('button', { name: /^filter$/i }).first().click();
        await expect(page.getByRole('listbox').first()).toBeVisible({ timeout: 10000 });

        // Drill into Status
        const statusRow = page.getByRole('option', { name: /^Status$/ });
        await statusRow.waitFor({ state: 'visible', timeout: 5000 });
        await statusRow.click();

        // Pick "Open"
        const open = page.getByRole('option', { name: /^Open$/ });
        await open.waitFor({ state: 'visible', timeout: 5000 });
        await open.click();

        await expect(page).toHaveURL(/[?&]status=OPEN/, { timeout: 10000 });
    });

    test('picking a due filter pushes it into the URL', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/farm-tasks`);
        await page.waitForLoadState('networkidle').catch(() => {});

        await page.getByRole('button', { name: /^filter$/i }).first().click();
        await expect(page.getByRole('listbox').first()).toBeVisible({ timeout: 10000 });

        const dueRow = page.getByRole('option', { name: /^Due$/ });
        await dueRow.waitFor({ state: 'visible', timeout: 5000 });
        await dueRow.click();

        const overdue = page.getByRole('option', { name: /^Overdue$/ });
        await overdue.waitFor({ state: 'visible', timeout: 5000 });
        await overdue.click();

        // Long timeout: dev-server can be mid-recompile for /farm-tasks after
        // a long suite, and router.replace is async.
        await expect(page).toHaveURL(/[?&]due=overdue/, { timeout: 30000 });
    });
});

test.describe('FilterToolbar — Vendors', () => {
    test.describe.configure({ mode: 'serial' });

    let tenantSlug: string;

    test('picking a criticality filter pushes it into the URL', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/vendors`);
        await page.waitForLoadState('networkidle').catch(() => {});

        await page.getByRole('button', { name: /^filter$/i }).first().click();
        await expect(page.getByRole('listbox').first()).toBeVisible({ timeout: 10000 });

        const criticalityRow = page.getByRole('option', { name: /^Criticality$/ });
        await criticalityRow.waitFor({ state: 'visible', timeout: 5000 });
        await criticalityRow.click();

        const high = page.getByRole('option', { name: /^High$/ });
        await high.waitFor({ state: 'visible', timeout: 5000 });
        await high.click();

        await expect(page).toHaveURL(/[?&]criticality=HIGH/, { timeout: 10000 });
    });
});
