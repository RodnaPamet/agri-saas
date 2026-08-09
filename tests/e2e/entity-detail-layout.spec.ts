/**
 * E2E — `<EntityDetailLayout>` structural promises (quality roadmap
 * P4, item 4).
 *
 * Detail-page shells are exercised tangentially by feature E2E (a
 * practice-edit spec navigates *through* the shell), but the layout's
 * own promises — the breadcrumb / header / rail / tab-bar
 * composition — have no dedicated browser test. This spec opens a
 * representative detail surface (a practice) and asserts the shell
 * paints the contract.
 *
 * The representative surface used to be a Risk; that register was
 * removed, so it is now a Practice — same shell, same double-click →
 * `/…/<id>` navigation contract.
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

test.describe('EntityDetailLayout', () => {
    test('practice detail page renders the shell — breadcrumbs, header, body', async ({
        page,
    }) => {
        const tenantSlug = await loginAndGetTenant(page);

        await safeGoto(page, `/t/${tenantSlug}/practices`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForLoadState('networkidle').catch(() => {});

        // Open a real practice — the first row of the seeded catalogue.
        const firstRow = page.locator('tbody tr').first();
        await expect(firstRow).toBeVisible({ timeout: 15_000 });
        await firstRow.dblclick();
        await page.waitForURL(/\/practices\/[a-zA-Z0-9-]+$/, {
            timeout: 15_000,
        });

        // The shell's three structural promises:
        // (1) the PageHeader subtree carrying breadcrumbs + title.
        await expect(
            page.locator('[data-testid="entity-detail-header"]'),
        ).toBeVisible({ timeout: 10_000 });
        // (2) the body wrapper. (The practice surface does not pass a
        //     `rail` — Linked Tasks live in the Tasks tab — so the
        //     rail is intentionally absent here; the AsidePanel
        //     primitive keeps its own rendered test.)
        await expect(
            page.locator('[data-entity-detail-layout]'),
        ).toBeVisible();
    });
});
