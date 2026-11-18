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
 *
 * ## Tenant SSO is turned OFF (owner ruling 2026-11-18)
 *
 * Dormant, not removed. The first describe asserts the production state —
 * no hub tile, and the configuration screen answers not-found. The second
 * turns `auth.tenant-sso` on for its own duration and runs the original
 * checks, so turning SSO back on is not a step into untested UI.
 */
import { test, expect } from '@playwright/test';
import { expectSettledSingle, loginAndGetTenant, safeGoto } from './e2e-utils';
import { enableFlags } from './feature-flag-fixtures';

const ADMIN_USER = { email: 'admin@acme.com', password: 'password123' };
const READER_USER = { email: 'viewer@acme.com', password: 'password123' };

test.describe('Admin SSO Configuration — turned off', () => {
    test('the hub offers no SSO or SCIM tile, while Entra keeps its own', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);
        await safeGoto(page, `/t/${tenantSlug}/admin`, { waitUntil: 'domcontentloaded' });
        const main = page.getByRole('main');
        // Positive control first: the hub rendered, so the absences below are
        // about the tiles and not about a page that never loaded.
        await expectSettledSingle(main.locator('#entra-pill-btn'), { timeout: 15000 });
        await expect(main.locator('#sso-pill-btn')).toHaveCount(0);
        await expect(main.locator('#scim-pill-btn')).toHaveCount(0);
    });

    test('the SSO and SCIM screens answer not-found to an admin', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);
        for (const sub of ['/admin/sso', '/admin/scim']) {
            await safeGoto(page, `/t/${tenantSlug}${sub}`, { waitUntil: 'domcontentloaded' });
            // The rendered not-found page, not the HTTP status: the parent
            // layouts have already streamed by the time the segment layout
            // calls `notFound()`, so the response is a 200 carrying it.
            await expect(
                page.getByRole('heading', { name: 'Page not found' }),
                `${sub} while turned off`,
            ).toBeVisible({ timeout: 30_000 });
            await expect(page.getByRole('button', { name: /Save Configuration/i })).toHaveCount(0);
            await expect(page.locator('#scim-endpoint-url')).toHaveCount(0);
        }
    });

    test('the configuration API answers 404', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);
        const res = await page.request.get(`/api/t/${tenantSlug}/sso`);
        expect(res.status()).toBe(404);
    });
});

test.describe('Admin SSO Configuration', () => {
    let restoreFlags: () => Promise<void> = async () => {};
    test.beforeAll(async () => {
        restoreFlags = await enableFlags('auth.tenant-sso');
    });
    test.afterAll(async () => {
        await restoreFlags();
    });


    // ── Warm-up test: hits /admin (already compiled) ──
    test('admin page shows SSO pill button', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);

        await safeGoto(page, `/t/${tenantSlug}/admin`, { waitUntil: 'domcontentloaded' });

        // The same barrier admin-regression.spec.ts applies to this very pill
        // row: during the admin page's hydration window a pill can transiently
        // render twice, and a bare toBeVisible() then fails with a strict-mode
        // violation instead of waiting the double out. The count still fails a
        // page that really did render two — `.first()` would pass on both.
        //
        // One call rather than two statements: the previous form claimed the
        // count assertion "waits for the window to close", and it does not —
        // it returns on the first observation of one. That is #1567.
        await expectSettledSingle(page.getByRole('main').locator('#sso-pill-btn'), {
            timeout: 15000,
        });
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
        await expect(page.getByRole('main').locator('#sso-tab-oidc')).toBeVisible({ timeout: 30000 });
        await expect(page.getByRole('main').locator('#sso-tab-saml')).toBeVisible({ timeout: 10000 });

        // Save button
        await expect(page.getByRole('button', { name: /Save Configuration/i })).toBeVisible({ timeout: 10000 });
    });

    test('admin can switch to SAML tab', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);

        await safeGoto(page, `/t/${tenantSlug}/admin/sso`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('main').locator('#sso-tab-saml')).toBeVisible({ timeout: 30000 });

        await page.getByRole('main').locator('#sso-tab-saml').click();

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

        // Same shape as admin-members: two INSTANT `isVisible()` reads and an
        // `expect(a && b).toBe(false)` that a blank page satisfies twice over.
        // Prove the guard rendered before asserting what it withheld.
        await expect(async () => {
            if (!new URL(page.url()).pathname.includes('/admin/sso')) return; // redirected — allowed
            await expect(page.getByRole('main').locator('#forbidden-heading')).toBeVisible();
        }).toPass({ timeout: 15_000 });

        await expect(page.getByRole('button', { name: /Save Configuration/i })).toHaveCount(0);
    });
});
