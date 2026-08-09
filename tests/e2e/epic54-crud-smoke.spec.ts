import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

/**
 * Epic 54 — cross-entity CRUD/detail smoke.
 *
 * One thin durable pass over the migrated surfaces. Per-entity specs
 * (`create-control-modal`, `control-edit-modal`, `evidence-upload-modal`,
 * `new-risk-modal`) already exercise the happy-paths in depth against
 * their own list pages; this spec is the cross-cutting canary that
 * verifies the Sheet-surface (which no per-entity spec tests) and the
 * `/new` redirect shims (which span Controls + Risks in one pass).
 *
 * We deliberately keep this short — running the per-entity scenarios
 * here as well was flaky under serial mode because multiple describe
 * blocks in the same browser context left Radix/Vaul focus-trap state
 * attached to `body`, and the duplicate coverage added no signal.
 */

test.describe('Epic 54 — CRUD/detail surfaces mount on demand', () => {
    test.describe.configure({ mode: 'serial' });

    let tenantSlug: string;

    test('Controls — quick-edit sheet opens from the list and exposes a full-detail link', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/controls`);
        // Wait for at least one control row to have a quick-edit icon.
        const quickEdit = page.locator('[data-testid^="control-quick-edit-"]').first();
        await quickEdit.waitFor({ state: 'visible', timeout: 15000 });

        await quickEdit.click();

        await expect(page.locator('[data-testid="control-sheet-open-full"]')).toBeVisible({
            timeout: 5000,
        });

        // Close the sheet so its focus-trap doesn't leak into the next test.
        await page.keyboard.press('Escape');
    });

    test('Redirect shim — /controls/new opens the modal', async ({ page }) => {
        // The paired /risks/new shim went with the risk register.
        tenantSlug = await loginAndGetTenant(page);

        await safeGoto(page, `/t/${tenantSlug}/controls/new`);
        await expect(page.locator('#control-name-input')).toBeVisible({ timeout: 15000 });
        await expect(page).toHaveURL(/\/controls(\?|$)/);
    });
});
