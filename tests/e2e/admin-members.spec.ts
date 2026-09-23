/**
 * E2E test: Admin Member Management
 *
 * Verifies:
 * 1. Admin can navigate to Members & Roles page
 * 2. Admin sees member list table
 * 3. Admin can open invite form
 * 4. Non-admin cannot access Members & Roles page
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

const ADMIN_USER = { email: 'admin@acme.com', password: 'password123' };
const READER_USER = { email: 'viewer@acme.com', password: 'password123' };

test.describe('Admin Member Management', () => {

    test('admin can view members page and see member list', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);

        await safeGoto(page, `/t/${tenantSlug}/admin/members`, { waitUntil: 'domcontentloaded' });

        // Page loads with header
        await expect(page.getByRole('heading', { name: /Members/i })).toBeVisible({ timeout: 30000 });

        // Members table should exist and have at least one row (the admin user)
        await expect(page.locator('#members-table')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('#members-table tbody tr').first()).toBeVisible({ timeout: 15000 });
    });

    test('admin can open invite form', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);

        await safeGoto(page, `/t/${tenantSlug}/admin/members`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#members-table')).toBeVisible({ timeout: 30000 });

        // Click invite button
        await page.click('#invite-member-btn');

        // Invite form should appear
        await expect(page.locator('#invite-form')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#invite-email-input')).toBeVisible();
        await expect(page.locator('#invite-role-select')).toBeVisible();
        await expect(page.locator('#send-invite-btn')).toBeVisible();
    });

    test('admin page shows members pill button', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, ADMIN_USER);

        await safeGoto(page, `/t/${tenantSlug}/admin`, { waitUntil: 'domcontentloaded' });

        // The pill is server-rendered exactly once (admin/page.tsx is the only
        // file in src/ that emits this id, and the shell renders {children}
        // once). But this test asserts at `domcontentloaded` — inside the
        // hydration window, where the subtree can momentarily exist twice. CI
        // caught precisely that: a strict-mode violation naming two identical
        // <a id="members-pill-btn">, with the snapshot taken moments later
        // showing only one.
        //
        // So wait for the count to SETTLE rather than reaching for `.first()`,
        // which would pass just as happily on a page that really did render
        // two. Same barrier the header assertion in admin-regression.spec.ts
        // already uses, for the same reason.
        const pill = page.locator('#members-pill-btn');
        await expect(pill).toHaveCount(1, { timeout: 15000 });
        await expect(pill).toBeVisible();
    });

    test('non-admin cannot access /admin/members', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, READER_USER);

        // Navigate to the admin members page as a non-admin user.
        // The middleware allows the page to load (returns 200) to avoid a
        // Next.js 14 dev server crash, but the admin/layout.tsx guard
        // renders a ForbiddenPage client-side.
        await safeGoto(page, `/t/${tenantSlug}/admin/members`, { waitUntil: 'domcontentloaded' });

        // The comment here used to read "the ForbiddenPage should be visible
        // (or at minimum the table should NOT be visible)" — and only the
        // weaker half was ever coded. `isVisible()` is an instant read that
        // returns false for a page that has not rendered, a 500, or a redirect
        // to /login, so `expect(...).toBe(false)` could not fail. The
        // `networkidle` above only delayed the same unconditioned check.
        //
        // Assert the guard's actual output first; the absence then means
        // something. Both outcomes the guard can produce are allowed, and
        // `toPass` retries an OBSERVATION, never an action.
        await expect(async () => {
            if (!new URL(page.url()).pathname.includes('/admin/members')) return; // redirected — allowed
            await expect(page.locator('#forbidden-heading')).toBeVisible();
        }).toPass({ timeout: 15_000 });

        await expect(page.locator('#members-table')).toHaveCount(0);

        // Verify the admin API endpoint properly rejects non-admin requests with 403
        const apiResult = await page.evaluate(async (slug: string) => {
            const res = await fetch(`/api/t/${slug}/admin/members`);
            return { status: res.status };
        }, tenantSlug);
        expect(apiResult.status).toBe(403);
    });
});
