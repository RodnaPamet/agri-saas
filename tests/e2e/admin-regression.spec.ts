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

        // The App Router keeps the outgoing tree mounted while the incoming
        // one streams in, so mid-transition BOTH render
        // `<h1 data-testid="page-header-title">Administration</h1>` and a bare
        // `locator('h1')` is a strict-mode violation, not a wait. The
        // `networkidle` that used to sit above hid that by running this late.
        //
        // Waiting for the count to SETTLE is the same barrier without blocking
        // on requests this test does not care about, and it asserts the
        // one-header invariant rather than stepping around it with `.first()`,
        // which would pass just as happily on a page that really did render
        // two.
        await expect(page.getByTestId('page-header-title')).toHaveCount(1, { timeout: 30000 });
        await expect(page.getByTestId('page-header-title')).toBeVisible();

        // The same settle-then-assert barrier the header above uses. These
        // pills sit in the same hydration window, and a transient double on
        // one of them is what reddened admin-members.spec.ts in CI — the
        // reasoning written above was applied to the header and not to these.
        for (const id of ['members-pill-btn', 'sso-pill-btn', 'scim-pill-btn', 'security-pill-btn']) {
            const pill = page.locator(`#${id}`);
            await expect(pill).toHaveCount(1, { timeout: 15000 });
            await expect(pill).toBeVisible();
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

        // Scoped to `main`, not page-level (#1495).
        //
        // This flaked as a TIMEOUT and was not one. The real failure:
        //
        //     strict mode violation: locator('#scim-endpoint-url')
        //     resolved to 2 elements
        //
        // The page emits that id exactly ONCE
        // (`admin/scim/page.tsx:159`), so the second element is a Next
        // STREAMING DUPLICATE of the page — the class CLAUDE.md already names:
        // "Scope `#id` / role locators to `getByRole('main')` where a Next
        // streaming duplicate of the page could match — never a bare
        // page-level locator." This test used the bare form the convention
        // forbids, and the duplicate only exists during streaming, which is
        // what made it look like a timing flake.
        //
        // The `60000 / 30000 / 10000` ladder is left alone deliberately: it is
        // a previous flake's scar tissue and worth revisiting, but changing
        // timeouts in the same diff as the real fix would make it impossible
        // to tell which one worked.
        const main = page.getByRole('main');
        await expect(main.getByRole('heading', { name: /SCIM Provisioning/i })).toBeVisible({ timeout: 60000 });
        await expect(main.locator('#scim-endpoint-url')).toBeVisible({ timeout: 30000 });
        await expect(main.locator('#generate-token-btn')).toBeVisible({ timeout: 10000 });
        const setupGuide = main.getByText('Setup Guide');
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

            // ONE positive assertion, not a three-way OR (#1514).
            //
            // The comment this replaces said "middleware should redirect
            // non-admin to dashboard". It does not, deliberately —
            // `src/middleware.ts:279-294` returns `NextResponse.next()` for an
            // admin PAGE and lets the Server Component guard in
            // `admin/layout.tsx` render `<ForbiddenPage>`, because redirecting
            // the HTML request crashed the Next 14 dev server. Only
            // `/api/admin` gets `ADMIN_REQUIRED`.
            //
            // So the URL STAYS on /admin, `!url.includes('/admin')` was false
            // on every one of these cases, and the OR never short-circuited on
            // its first term. The three-way shape then had two problems:
            //
            //   • the sound check was a BARE `#id` behind `.catch(() => false)`,
            //     so a Next streaming duplicate — the #1495 failure, in this
            //     very file — silently degraded it to `false`;
            //   • the fallback `/access/i` cannot tell a denial page from the
            //     admin page it excludes. Measured: 22 admin-namespace strings
            //     contain "access", including
            //     `admin.rbac.breadcrumbRolesAccess` = "Roles & Access", a
            //     breadcrumb on /admin/rbac — one of the subpages below.
            //
            // Together: if the layout guard ever broke, a READER would see the
            // RBAC admin page and this test would pass on its breadcrumb.
            //
            // The contract is "the ForbiddenPage renders". Asserted directly,
            // scoped to `main` so a streaming duplicate is a pass rather than a
            // swallowed false, and with no `.catch` — a strict-mode violation
            // is information, not a `false`.
            await expect(
                page.getByRole('main').locator('#forbidden-heading'),
            ).toBeVisible({ timeout: 15_000 });
        });
    }
});
