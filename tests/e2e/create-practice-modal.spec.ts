/**
 * Epic 54 — Create Practice modal migration.
 *
 * Verifies the in-list modal path that replaces the legacy
 * `/practices/new` full-page form: clicking `#new-practice-btn` opens
 * the modal without navigation, Cancel closes it, submit stays
 * disabled until Name is supplied, and a successful submit creates
 * the practice + navigates to its detail page.
 *
 * Isolation: each `test()` runs on its own fresh, empty tenant via
 * the `isolatedTenant` fixture. The "submitting creates the
 * practice" test writes a row that, on an isolated tenant, cannot
 * pollute the shared seeded tenant.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { test, expect } from './fixtures';
import { safeGoto } from './e2e-utils';

test.describe('Epic 54 — Create Practice modal', () => {
    test('clicking + Practice opens the modal without navigating away', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/practices`);
        await authedPage.reload({ waitUntil: 'domcontentloaded' });
        const newBtn = authedPage.locator('#new-practice-btn').first();
        await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
        await authedPage.waitForLoadState('networkidle').catch(() => {});
        const listUrl = authedPage.url();

        await newBtn.click();

        await expect(authedPage.locator('#practice-name-input')).toBeVisible({
            timeout: 60_000,
        });
        expect(authedPage.url()).toBe(listUrl);

        await authedPage.click('#new-practice-cancel-btn');
        await expect(authedPage.locator('#practice-name-input')).toBeHidden({
            timeout: 5000,
        });
    });

    test('Cancel closes the modal and leaves the list untouched', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/practices`);
        await authedPage.reload({ waitUntil: 'domcontentloaded' });
        const newBtn = authedPage.locator('#new-practice-btn').first();
        await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
        await authedPage.waitForLoadState('networkidle').catch(() => {});
        await newBtn.click();
        await expect(authedPage.locator('#practice-name-input')).toBeVisible({
            timeout: 60_000,
        });

        await authedPage.click('#new-practice-cancel-btn');

        await expect(authedPage.locator('#practice-name-input')).toBeHidden({
            timeout: 5000,
        });
        await expect(authedPage.locator('#practices-table')).toBeVisible();
    });

    test('Create Practice button is disabled until Name is filled', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/practices`);
        await authedPage.reload({ waitUntil: 'domcontentloaded' });
        const newBtn = authedPage.locator('#new-practice-btn').first();
        await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
        await authedPage.waitForLoadState('networkidle').catch(() => {});
        await newBtn.click();
        await expect(authedPage.locator('#practice-name-input')).toBeVisible({
            timeout: 60_000,
        });

        await expect(authedPage.locator('#create-practice-btn')).toBeDisabled();
        await authedPage.fill('#practice-name-input', 'A');
        await expect(authedPage.locator('#create-practice-btn')).toBeEnabled();
        await authedPage.fill('#practice-name-input', '');
        await expect(authedPage.locator('#create-practice-btn')).toBeDisabled();

        await authedPage.click('#new-practice-cancel-btn');
        await expect(authedPage.locator('#practice-name-input')).toBeHidden({
            timeout: 5000,
        });
    });

    test('submitting creates the practice and navigates to the detail page', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/practices`);
        await authedPage.reload({ waitUntil: 'domcontentloaded' });
        const newBtn = authedPage.locator('#new-practice-btn').first();
        await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
        await authedPage.waitForLoadState('networkidle').catch(() => {});
        await newBtn.click();
        await expect(authedPage.locator('#practice-name-input')).toBeVisible({
            timeout: 60_000,
        });

        const uid = Date.now().toString(36);
        const name = `Modal E2E Practice ${uid}`;
        await authedPage.fill('#practice-name-input', name);
        await authedPage.fill('#practice-code-input', `MOD-${uid}`);
        await authedPage.fill(
            '#practice-description-input',
            'Created via the Epic 54 modal.',
        );

        const [response] = await Promise.all([
            authedPage.waitForResponse(
                (r) =>
                    r.url().includes('/api/t/') &&
                    r.url().endsWith('/practices') &&
                    r.request().method() === 'POST',
            ),
            authedPage.click('#create-practice-btn'),
        ]);
        expect(response.status(), 'POST /practices succeeded').toBeLessThan(400);

        await authedPage.waitForSelector('#practice-title', { timeout: 15000 });
        await expect(authedPage.locator('#practice-title')).toContainText(name, {
            timeout: 5000,
        });
    });

    test('/practices/new deep link redirects to the list with the modal auto-open', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/practices/new`);

        await expect(authedPage.locator('#practice-name-input')).toBeVisible({
            timeout: 15000,
        });
        await expect(authedPage).toHaveURL(/\/practices(\?|$)/);
    });
});
