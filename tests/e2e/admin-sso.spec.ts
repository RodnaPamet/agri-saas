/**
 * E2E test: Admin SSO Configuration
 *
 * Verifies:
 * 1. Admin page shows SSO pill button (warms admin route)
 * 2. Admin can navigate to SSO config page with protocol tabs
 * 3. Admin can switch to SAML tab
 * 4. Non-admin cannot access SSO config page
 *
 * Tests are ordered so simpler/lighter tests run first, warming up the
 * dev-server compilation cache before the heavier SSO page tests.
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

const ADMIN_USER = { email: 'admin@acme.com', password: 'password123' };
const READER_USER = { email: 'viewer@acme.com', password: 'password123' };

test.describe('Admin SSO Configuration', () => {

    // ── Warm-up test: hits /admin (already compiled) ──
    test('admin page shows SSO pill button', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);

        await safeGoto(page, `/t/${tenantSlug}/admin`, { waitUntil: 'domcontentloaded' });

        await expect(page.locator('#sso-pill-btn')).toBeVisible({ timeout: 15000 });
    });

    // ── SSO page tests: server should be warm from admin page ──
    test('admin can view SSO config page with protocol tabs', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);

        await safeGoto(page, `/t/${tenantSlug}/admin/sso`, { waitUntil: 'domcontentloaded' });
        // Wait for fetchProviders() — tabs are hidden behind a loading skeleton until API returns

        // Page header — wait up to 60s for first cold-compile
        await expect(page.getByRole('heading', { name: /SSO & Identity/i })).toBeVisible({ timeout: 60000 });

        // Protocol tabs — only render after loading=false (API response received).
        // Epic 60 migrated this toggle to <ToggleGroup> which exposes
        // role="radio" inside a role="radiogroup" (not role="button").
        // Target by the stable ids preserved on each option (see
        // src/app/t/[tenantSlug]/(app)/admin/sso/page.tsx).
        await expect(page.locator('#sso-tab-oidc')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('#sso-tab-saml')).toBeVisible({ timeout: 10000 });

        // Save button
        await expect(page.getByRole('button', { name: /Save Configuration/i })).toBeVisible({ timeout: 10000 });
    });

    test('admin can switch to SAML tab', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);

        await safeGoto(page, `/t/${tenantSlug}/admin/sso`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#sso-tab-saml')).toBeVisible({ timeout: 30000 });

        await page.locator('#sso-tab-saml').click();

        // SAML-specific heading should appear
        await expect(page.getByRole('heading', { name: /SAML/i })).toBeVisible({ timeout: 5000 });
    });

    // ── Guard test: non-admin ──
    test('non-admin cannot access /admin/sso', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, READER_USER);

        // Navigate to the admin SSO page as a non-admin user.
        // The middleware allows the page to load (returns 200) to avoid a
        // Next.js 14 dev server crash, but the admin/layout.tsx guard
        // renders a ForbiddenPage client-side.
        await safeGoto(page, `/t/${tenantSlug}/admin/sso`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});

        // The SSO config content should NOT be visible to a non-admin
        const hasSsoConfig = await page.getByRole('heading', { name: /SSO/i }).isVisible().catch(() => false);
        const hasSaveBtn = await page.getByRole('button', { name: /Save Configuration/i }).isVisible().catch(() => false);
        expect(hasSsoConfig && hasSaveBtn).toBe(false);
    });
});
