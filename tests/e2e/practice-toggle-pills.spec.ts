import { test, expect } from '@playwright/test';
import { loginAndGetTenant } from './e2e-utils';

/**
 * Practices list — read-only Status + Applicability badges.
 *
 * 2026-05-19 — the inline-edit `<select>` dropdowns on the
 * Practices list table were retired at the user's request. Status
 * changes now route through the detail page (Edit Practice sheet)
 * or the bulk-set toolbar; applicability changes route through
 * the detail page where the justification modal lives.
 *
 * Pre-retirement, this spec exercised the dropdown end-to-end:
 *   • status select → pick value → confirm POST
 *   • applicability → N/A → justification modal → save
 *   • reader sees a static <span> not a select
 *
 * Post-retirement, every viewer sees the same read-only badge.
 * The spec retains the load-bearing existence checks (id parity
 * for downstream selectors + non-`<select>` shape) so a future
 * regression that re-introduces the inline editor on the list
 * fails CI; the transition flows themselves are covered by the
 * per-practice detail-page specs.
 */

test.describe('Practices list — read-only status/applicability badges', () => {
    test.describe.configure({ mode: 'serial' });

    test('status pill renders as a <span> (NOT a <select>)', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await page.goto(`/t/${tenantSlug}/practices`);
        await page.waitForSelector('#practices-table', { timeout: 15000 });

        const firstRow = page.locator('#practices-table tbody tr').first();
        const statusPill = firstRow.locator('[id^="status-pill-"]');
        await expect(statusPill).toBeVisible({ timeout: 5000 });

        // Read-only: must NOT be a <select>. A future PR that
        // re-introduces the inline editor on the list page would
        // fail this assertion.
        const tagName = await statusPill.evaluate((el) =>
            el.tagName.toLowerCase(),
        );
        expect(tagName).not.toBe('select');
    });

    test('applicability pill renders as a <span> (NOT a <select>)', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await page.goto(`/t/${tenantSlug}/practices`);
        await page.waitForSelector('#practices-table', { timeout: 15000 });

        const firstRow = page.locator('#practices-table tbody tr').first();
        const applicabilityPill = firstRow.locator(
            '[id^="applicability-pill-"]',
        );
        await expect(applicabilityPill).toBeVisible({ timeout: 5000 });

        const tagName = await applicabilityPill.evaluate((el) =>
            el.tagName.toLowerCase(),
        );
        expect(tagName).not.toBe('select');
    });

    test('justification modal is NOT mounted on the list page', async ({ page }) => {
        // Pre-retirement, picking N/A in the list opened the
        // modal here. The modal infrastructure moved to the
        // detail page; the list no longer carries it.
        const tenantSlug = await loginAndGetTenant(page);
        await page.goto(`/t/${tenantSlug}/practices`);
        await page.waitForSelector('#practices-table', { timeout: 15000 });

        await expect(page.locator('#justification-input')).toHaveCount(0);
        await expect(page.locator('#justification-save-btn')).toHaveCount(0);
    });
});
