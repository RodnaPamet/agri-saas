/**
 * RENAMED from `practices-enhanced.spec.ts` — the old name described
 * neither what survives (one activity-tab case) nor where it runs.
 *
 * Entity-detail activity tab — mutating E2E.
 *
 * GRC teardown phase 2 — this file was `Practices Enhanced` and drove
 * `/practices/<id>`, which was DELETED. The one surviving test asserts
 * a PLATFORM behaviour, not a practice one: a detail page's Activity
 * tab renders either the audit feed or its empty state. `/assets/<id>`
 * carries the same tab (`EntityDetailLayout` renders the trigger as
 * `#tab-activity`; the asset page renders `#asset-activity-feed` or an
 * `InlineEmptyState` whose description reads "No activity recorded for
 * this asset yet."), so the test is RE-POINTED there rather than
 * dropped. The practices dashboard test that used to open this block
 * (`/practices/dashboard` — stats + implementation-progress + sankey)
 * had already gone with the practice exoskeleton and is not replaced:
 * no surviving page reproduces it.
 *
 * Isolation: the test runs on its own fresh, empty tenant via the
 * `isolatedTenant` fixture and creates the asset whose activity it
 * inspects, so it is self-contained and order-independent.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { safeGoto } from './e2e-utils';

/** Create an asset on the isolated tenant; land on its detail page. */
async function createAsset(page: Page, slug: string): Promise<void> {
    const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    let r = 3;
    while (r > 0) {
        // `/assets/new` is a server redirect onto `/assets?create=1`,
        // which AssetsClient detects and opens <NewAssetModal> for.
        const resp = await safeGoto(page, `/t/${slug}/assets/new`, {
            waitUntil: 'domcontentloaded',
        });
        if (resp && resp.status() < 500) break;
        r--;
        if (r > 0) await page.waitForTimeout(5000);
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForSelector('#asset-name-input', { timeout: 30000 });
    // `name` is the only required field — `type` / `status` default to
    // TRACTOR / ACTIVE in useNewAssetForm.
    await page.fill('#asset-name-input', `Enhanced Test ${uid}`);
    await page.click('#create-asset-submit');
    // The modal's onSuccess pushes to the new asset's detail page.
    await page.waitForURL('**/assets/**', { timeout: 30000 });
    await page.waitForSelector('#asset-title-heading', { timeout: 30000 });
}

test.describe('Entity detail — activity tab', () => {
    test('activity tab shows events', async ({ authedPage, isolatedTenant }) => {
        // Self-contained: create the asset whose activity we inspect.
        await createAsset(authedPage, isolatedTenant.tenantSlug);

        await authedPage.click('#tab-activity');

        // The activity tab renders EITHER the feed or an empty-state.
        // A single web-first assertion on the union locator auto-retries
        // until one of them appears — robust against a slow render under
        // heavy CI load (the old `Promise.race` + instantaneous
        // `isVisible()` pattern flaked when neither had painted within a
        // fixed 15s window).
        const activityOrEmpty = authedPage
            .locator('#asset-activity-feed')
            .or(authedPage.getByText(/No activity recorded/i));
        await expect(activityOrEmpty.first()).toBeVisible({ timeout: 30000 });
    });
});
