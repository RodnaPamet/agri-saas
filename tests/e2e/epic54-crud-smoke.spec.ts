import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

/**
 * Epic 54 — cross-entity CRUD/detail smoke.
 *
 * One thin durable pass over the migrated surfaces. Per-entity specs
 * already exercise the happy-paths in depth against their own list
 * pages; this spec is the cross-cutting canary for the `/new` redirect
 * shims, which no per-entity spec covers.
 *
 * We deliberately keep this short — running the per-entity scenarios
 * here as well was flaky under serial mode because multiple describe
 * blocks in the same browser context left Radix/Vaul focus-trap state
 * attached to `body`, and the duplicate coverage added no signal.
 *
 * GRC teardown phase 2 — this spec used to open a SECOND surface: the
 * practices quick-edit Sheet (`practice-quick-edit-*` →
 * `practice-sheet-open-full`), which was its only Sheet coverage. That
 * affordance was deleted along with `/practices`, and no surviving list
 * page reproduces it: the remaining Sheet surfaces (evidence detail,
 * exchange, grain-contract deliveries, process rule detail) all sit on
 * pages the shared tenant seeds no rows for, so re-pointing the test
 * would have produced a locator that never resolves. It is dropped
 * rather than faked — Sheet coverage needs a seeded surface first.
 */

test.describe('Epic 54 — CRUD/detail surfaces mount on demand', () => {
    test.describe.configure({ mode: 'serial' });

    test('Redirect shim — /assets/new opens the create modal', async ({ page }) => {
        // Re-pointed from `/practices/new` (GRC teardown phase 2). The
        // shim contract is identical and entity-agnostic: the `/new`
        // page is a server `redirect()` to `/<entity>?create=1`, and the
        // list client opens its create modal on that param and then
        // strips it from the URL. `/assets/new` is the surviving
        // instance of that pattern.
        // The paired `/risks/new` shim went earlier, with the risk register.
        const tenantSlug = await loginAndGetTenant(page);

        await safeGoto(page, `/t/${tenantSlug}/assets/new`);
        await expect(page.locator('#asset-name-input')).toBeVisible({ timeout: 15000 });
        await expect(page).toHaveURL(/\/assets(\?|$)/);
    });
});
