/**
 * E2E test: RBAC access control
 * Verifies that non-admin users are blocked from admin-only pages
 * and see the forbidden UX rather than the admin content.
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

const ADMIN_USER = { email: 'admin@acme.com', password: 'password123' };
const READER_USER = { email: 'viewer@acme.com', password: 'password123' };

test.describe('RBAC Access Control', () => {
    // Each test independently logs in — no need for serial execution.
    // Per-test retries handle transient dev server crashes without cascade failures.

    test('admin can access admin/rbac page', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);

        // Verify actual content rendered. safeGoto handles connection errors.
        let attempts = 2;
        while (attempts > 0) {
            await safeGoto(page, `/t/${tenantSlug}/admin/rbac`, { waitUntil: 'domcontentloaded' });

            // An auto-waiting probe instead of `networkidle` + an INSTANT
            // `isVisible()`. The instant check is what made the full network
            // wait load-bearing, and it still raced it; this returns the
            // moment the content appears and costs nothing when it is already
            // there. The retry stays because only a re-navigation recovers a
            // dev-server 500 — no assertion can.
            const rendered = await page
                .locator('text=Permission Matrix')
                .first()
                .waitFor({ state: 'visible', timeout: 15_000 })
                .then(() => true)
                .catch(() => false);
            if (rendered) break;

            attempts--;
        }

        await expect(page.locator('text=Roles').first()).toBeVisible({ timeout: 15000 });
        await expect(page.locator('text=Permission Matrix').first()).toBeVisible({ timeout: 15000 });
    });

    test('non-admin navigating to admin/rbac sees forbidden or redirect', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, READER_USER);

        // Navigate to the admin RBAC page as a non-admin user.
        // The middleware allows the page to load (returns 200) to avoid a
        // Next.js 14 dev server crash, but the admin/layout.tsx guard
        // renders a ForbiddenPage client-side.
        await safeGoto(page, `/t/${tenantSlug}/admin/rbac`, { waitUntil: 'domcontentloaded' });

        // A positive control, before the absence. On its own
        // `not.toBeVisible()` passes on a blank page, a 500, a redirect to
        // /login and a page that simply has not rendered yet — every way this
        // test could be meaningless is indistinguishable from its pass, and
        // the `networkidle` that used to stand here made that MORE likely to
        // look fine rather than less, because it only delayed the same
        // unconditioned check.
        //
        // The test name allows two outcomes, so the control accepts either:
        // still on the admin route showing the forbidden UX, or navigated
        // away from it. `toPass` retries an OBSERVATION here, never an action.
        await expect(async () => {
            if (!new URL(page.url()).pathname.includes('/admin/rbac')) return; // redirected — allowed
            await expect(page.locator('#forbidden-heading')).toBeVisible();
        }).toPass({ timeout: 15_000 });

        // ...and only now is the absence meaningful.
        await expect(page.locator('text=Permission Matrix')).not.toBeVisible();
    });

    test('non-admin does not see Admin nav item in sidebar', async ({ page }) => {
        // loginAndGetTenant guarantees: URL matches + sidebar rendered + server-side
        // permissions resolved. If the page was a 500, the helper already reloaded it.
        await loginAndGetTenant(page, READER_USER);

        // With defense-in-depth (noStore + fail-closed filter), the admin link
        // should never be in the DOM for a reader user. No hydration wait needed.
        // Same shape as above: assert the nav itself rendered, or "the admin
        // link is not visible" is also satisfied by there being no nav at all.
        await expect(page.locator('aside')).toBeVisible({ timeout: 15_000 });
        // `toHaveCount(0)` rather than `not.toBeVisible()` because the claim in
        // the comment above is that it is never in the DOM, which is the
        // stronger property and the one worth pinning.
        await expect(page.locator('aside [data-testid="nav-admin"]')).toHaveCount(0);
    });
});
