/**
 * Controls Enhanced — mutating E2E (dashboard + detail-page extras).
 *
 * Isolation: each `test()` runs on its own fresh, empty tenant via
 * the `isolatedTenant` fixture. The "activity tab" / "automation
 * section" tests previously clicked the FIRST row of the controls
 * table — which only works if the seed tenant already has controls.
 * On an isolated (empty) tenant they now create their own control
 * first, so the test is self-contained and order-independent.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { safeGoto } from './e2e-utils';

/** Create a control on the isolated tenant; land on its detail page. */
async function createControl(page: Page, slug: string): Promise<void> {
    const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    let r = 3;
    while (r > 0) {
        const resp = await safeGoto(page, `/t/${slug}/controls/new`, {
            waitUntil: 'domcontentloaded',
        });
        if (resp && resp.status() < 500) break;
        r--;
        if (r > 0) await page.waitForTimeout(5000);
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForSelector('#control-name-input', { timeout: 30000 });
    await page.fill('#control-name-input', `Enhanced Test ${uid}`);
    await page.fill('#control-code-input', `ENH-${uid}`);
    await page.click('#create-control-btn');
    await page.waitForURL('**/controls/**', { timeout: 30000 });
    await page.waitForSelector('#control-title', { timeout: 30000 });
}

// The `dashboard loads and shows metrics` test that opened this block
// drove `/t/<slug>/controls/dashboard` — the controls dashboard (stats +
// implementation-progress + sankey) deleted with the control exoskeleton.
// It had no subject left; the activity tab below is unaffected.
test.describe('Controls Enhanced', () => {
    test('activity tab shows events', async ({ authedPage, isolatedTenant }) => {
        // Self-contained: create the control whose activity we inspect.
        await createControl(authedPage, isolatedTenant.tenantSlug);

        await authedPage.click('#tab-activity');

        // The activity tab renders EITHER the feed or an empty-state.
        // A single web-first assertion on the union locator auto-retries
        // until one of them appears — robust against a slow render under
        // heavy CI load (the old `Promise.race` + instantaneous
        // `isVisible()` pattern flaked when neither had painted within a
        // fixed 15s window).
        const activityOrEmpty = authedPage
            .locator('#activity-feed')
            .or(authedPage.getByText('No activity recorded'));
        await expect(activityOrEmpty.first()).toBeVisible({ timeout: 30000 });
    });
});
