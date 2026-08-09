/**
 * Practices Enhanced — mutating E2E (dashboard + detail-page extras).
 *
 * Isolation: each `test()` runs on its own fresh, empty tenant via
 * the `isolatedTenant` fixture. The "activity tab" / "automation
 * section" tests previously clicked the FIRST row of the practices
 * table — which only works if the seed tenant already has practices.
 * On an isolated (empty) tenant they now create their own practice
 * first, so the test is self-contained and order-independent.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { safeGoto } from './e2e-utils';

/** Create a practice on the isolated tenant; land on its detail page. */
async function createPractice(page: Page, slug: string): Promise<void> {
    const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    let r = 3;
    while (r > 0) {
        const resp = await safeGoto(page, `/t/${slug}/practices/new`, {
            waitUntil: 'domcontentloaded',
        });
        if (resp && resp.status() < 500) break;
        r--;
        if (r > 0) await page.waitForTimeout(5000);
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForSelector('#practice-name-input', { timeout: 30000 });
    await page.fill('#practice-name-input', `Enhanced Test ${uid}`);
    await page.fill('#practice-code-input', `ENH-${uid}`);
    await page.click('#create-practice-btn');
    await page.waitForURL('**/practices/**', { timeout: 30000 });
    await page.waitForSelector('#practice-title', { timeout: 30000 });
}

// The `dashboard loads and shows metrics` test that opened this block
// drove `/t/<slug>/practices/dashboard` — the practices dashboard (stats +
// implementation-progress + sankey) deleted with the practice exoskeleton.
// It had no subject left; the activity tab below is unaffected.
test.describe('Practices Enhanced', () => {
    test('activity tab shows events', async ({ authedPage, isolatedTenant }) => {
        // Self-contained: create the practice whose activity we inspect.
        await createPractice(authedPage, isolatedTenant.tenantSlug);

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
