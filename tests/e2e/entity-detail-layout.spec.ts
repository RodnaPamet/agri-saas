/**
 * E2E — `<EntityDetailLayout>` structural promises (quality roadmap
 * P4, item 4).
 *
 * Detail-page shells are exercised tangentially by feature E2E (an
 * asset-edit spec navigates *through* the shell), but the layout's
 * own promises — the breadcrumb / header / rail / tab-bar
 * composition — have no dedicated browser test. This spec opens a
 * representative detail surface and asserts the shell paints the
 * contract.
 *
 * The representative surface has moved twice. It was a Risk until that
 * register was removed, then a Practice until the GRC teardown removed
 * `/practices` (phase 2). It is now an Asset — same shell, same
 * double-click → `/…/<id>` navigation contract, and the assets list is
 * seeded (3 rows) so the first row is always there to open. The
 * assertion was never about the entity: it is about the shell, which
 * `/assets/[id]` mounts exactly as the practice detail page did.
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

test.describe('EntityDetailLayout', () => {
    test('asset detail page renders the shell — breadcrumbs, header, body', async ({
        page,
    }) => {
        const tenantSlug = await loginAndGetTenant(page);

        await safeGoto(page, `/t/${tenantSlug}/assets`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForLoadState('networkidle').catch(() => {});

        // Open a real asset — the first row of the seeded fleet.
        const firstRow = page
            .getByRole('main')
            .locator('[data-testid="assets-table"] tbody tr')
            .first();
        await expect(firstRow).toBeVisible({ timeout: 15_000 });
        // The last cell is DataTable's trailing chevron column
        // (`aria-hidden`, `pointer-events-none`) — a guaranteed
        // non-interactive double-click target, unlike the leading
        // select checkbox or the title `<Link>` in the name cell.
        await firstRow.locator('td').last().dblclick();
        await page.waitForURL(/\/assets\/[a-zA-Z0-9-]+$/, {
            timeout: 15_000,
        });

        // The shell's three structural promises:
        // (1) the PageHeader subtree carrying breadcrumbs + title.
        await expect(
            page.locator('[data-testid="entity-detail-header"]'),
        ).toBeVisible({ timeout: 10_000 });
        // (2) the body wrapper. (The asset surface does not pass a
        //     `rail` — linked Tasks live in their own tab — so the
        //     rail is intentionally absent here; the AsidePanel
        //     primitive keeps its own rendered test.)
        await expect(
            page.locator('[data-entity-detail-layout]'),
        ).toBeVisible();
    });
});
