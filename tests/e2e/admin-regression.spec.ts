/**
 * E2E regression tests for Epic 12: Admin UI & RBAC Management
 *
 * Tests:
 * - Admin landing page has all pill buttons (Members, SSO, SCIM, Security)
 * - SCIM admin page renders (heading, endpoint URL, generate button, setup guide)
 * - SCIM token generation flow
 * - Non-admin user cannot access SCIM admin page
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

const ADMIN_USER = { email: 'admin@acme.com', password: 'password123' };
const READER_USER = { email: 'viewer@acme.com', password: 'password123' };

test.describe('Admin Area Regression', () => {

    // ── 1. Warm-up: admin pill buttons ──
    test('admin page shows all pill buttons', async ({ page }) => {
        const slug = await loginAndGetTenant(page, ADMIN_USER);
        await safeGoto(page, `/t/${slug}/admin`, { waitUntil: 'domcontentloaded' });

        await expect(page.locator('h1')).toBeVisible({ timeout: 30000 });

        for (const id of ['members-pill-btn', 'sso-pill-btn', 'scim-pill-btn', 'security-pill-btn']) {
            await expect(page.locator(`#${id}`)).toBeVisible({ timeout: 5000 });
        }
    });

    // ── 2. SCIM page renders ──
    // The `#scim-endpoint-url` slot is now rendered eagerly (with a
    // "Loading endpoint…" placeholder) so the selector resolves before
    // the GET /admin/scim fetch lands. The previous `test.fixme()` was
    // a workaround for the slot only mounting after `setState`, which
    // could time out on cold-compile dev-server runs.
    test('SCIM admin page renders token management', async ({ page }) => {
        const slug = await loginAndGetTenant(page, ADMIN_USER);
        await safeGoto(page, `/t/${slug}/admin/scim`, { waitUntil: 'domcontentloaded' });

        await expect(page.getByRole('heading', { name: /SCIM Provisioning/i })).toBeVisible({ timeout: 60000 });
        await expect(page.locator('#scim-endpoint-url')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('#generate-token-btn')).toBeVisible({ timeout: 10000 });
        const setupGuide = page.getByText('Setup Guide');
        await setupGuide.scrollIntoViewIfNeeded();
        await expect(setupGuide).toBeVisible({ timeout: 10000 });
    });

    // ── 3. Non-admin access blocked on ALL admin subpages ──
    const adminSubpages = [
        '', // root admin page
        '/members',
        '/rbac',
        '/sso',
        '/scim',
        '/security',
        '/integrations',
        '/billing',
    ];

    for (const subpage of adminSubpages) {
        const label = subpage || '(root)';
        test(`non-admin cannot access admin${label} page`, async ({ page }) => {
            const slug = await loginAndGetTenant(page, READER_USER);
            await safeGoto(page, `/t/${slug}/admin${subpage}`, { waitUntil: 'domcontentloaded' });

            // Middleware should redirect non-admin to dashboard.
            // If it doesn't (edge case), the admin layout guard shows
            // the ForbiddenPage with "Access Denied" / "Permission denied".
            const url = page.url();
            const notOnAdmin = !url.includes('/admin');
            const hasForbidden = await page.locator('#forbidden-heading').isVisible().catch(() => false);
            const hasPermissionText = await page.getByText(/permission|forbidden|denied|access/i).isVisible().catch(() => false);

            expect(notOnAdmin || hasForbidden || hasPermissionText).toBeTruthy();
        });
    }
});
