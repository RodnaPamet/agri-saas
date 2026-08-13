/**
 * Epic O-4 — CISO portfolio journey (E2E).
 *
 * Walks the full hub-and-spoke flow against the production-mode
 * Next server, the seeded `acme-org` Organization, and the seeded
 * `acme-corp` child Tenant (which already has assets / evidence
 * courtesy of `prisma/seed.ts`):
 *
 *   A. Login as `ciso@acme.com` (ORG_ADMIN of acme-org, AUDITOR
 *      of acme-corp). Confirms the read-only AUDITOR badge on the
 *      tenant chrome.
 *
 *   B. Portfolio overview at `/org/acme-org` renders the stat
 *      cards + the drill-down CTAs + the per-tenant coverage list.
 *
 *   E. Drill-down list at `/org/acme-org/evidence` renders with
 *      tenant attribution columns (RLS-enforced read via the
 *      auto-provisioned AUDITOR membership).
 *
 *   F. Read-only invariant: the AUDITOR membership grants no
 *      `canWrite`, so a tenant list page must NOT render its create
 *      button.
 *
 *   G. Tenant creation via `/org/acme-org/tenants/new`. Confirms
 *      the new tenant appears in the org tenants list. We do NOT
 *      navigate into the new tenant — the in-flight session JWT
 *      doesn't carry the just-issued OWNER membership until next
 *      refresh, and the middleware tenant-access gate is JWT-bound
 *      (separate concern, predates Epic O-4).
 *
 *   H. OrgSwitcher pivots from portfolio context to a tenant
 *      workspace via the sidebar header dropdown.
 *
 * GRC teardown phase 2 — test C (the `/org/acme-org/practices`
 * drill-down) was DELETED, not re-pointed. Both halves of it are gone:
 * the org-level route `/org/:slug/practices` and the per-tenant
 * `/t/:slug/practices/:id` detail page it drilled into. The surviving
 * org drill-down is evidence, and test E already covers that exact
 * shape (table renders, rows carry tenant attribution, or the empty
 * state) — re-pointing C at `/org/:slug/evidence` would have produced
 * a duplicate of E rather than new coverage. What is genuinely lost is
 * the org→tenant NAVIGATION hop: no surviving org drill-down row links
 * out to a per-tenant detail page.
 *
 * Each test re-logs in and re-navigates from scratch — matches the
 * pattern in `core-flow.spec.ts` so a single failure doesn't cascade
 * across the suite.
 */
import { test, expect } from '@playwright/test';
import { type Page } from '@playwright/test';
import { safeGoto, waitForHydration } from './e2e-utils';

const CISO = { email: 'ciso@acme.com', password: 'password123' };
const ORG_SLUG = 'acme-org';
const SEED_TENANT = 'acme-corp';

/**
 * CISO-aware login helper.
 *
 * `loginAndGetTenant` from `e2e-utils` only succeeds when the user
 * has a single TenantMembership (post-login redirect lands directly
 * on `/t/{slug}/dashboard`). Once test G creates a 2nd tenant, the
 * CISO has two memberships and post-login lands on the `/tenants`
 * picker. This helper handles both cases — single-tenant fast path
 * and multi-tenant picker — and returns the seeded tenant slug.
 */
async function loginAsCiso(page: Page, preferredTenant = SEED_TENANT): Promise<string> {
    await safeGoto(page, '/login', { timeout: 90_000 });

    const credentialsForm = page.locator('#credentials-form');
    const emailInput = credentialsForm.locator('input[type="email"][name="email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 30_000 });

    // Wait for React hydration so onSubmit is wired up.
    await page.waitForFunction(() => {
        const form = document.querySelector('form');
        return form && Object.keys(form).some(k => k.startsWith('__reactEvents') || k.startsWith('__reactFiber'));
    }, { timeout: 30_000 });

    await emailInput.fill(CISO.email);
    await credentialsForm.locator('input[type="password"]').fill(CISO.password);
    await credentialsForm.locator('button[type="submit"]').click();

    // Post-login lands on either `/t/{slug}/dashboard` (single
    // membership) or `/tenants` (picker). Wait for either, then
    // pivot to the preferred tenant if we hit the picker.
    await page.waitForURL(
        (url) =>
            /\/t\/[^/]+\/dashboard/.test(url.pathname) ||
            url.pathname === '/tenants',
        { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );

    if (page.url().includes('/tenants')) {
        const link = page.locator(`a[href="/t/${preferredTenant}/dashboard"]`).first();
        await link.waitFor({ state: 'visible', timeout: 30_000 });
        await link.click();
        await page.waitForURL(new RegExp(`/t/${preferredTenant}/dashboard`), {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        });
    }

    // Verify the tenant chrome rendered.
    await page.locator('aside').first().waitFor({ state: 'visible', timeout: 30_000 });

    const match = new URL(page.url()).pathname.match(/^\/t\/([^/]+)\//);
    if (!match) throw new Error('Could not extract tenant slug from ' + page.url());
    return match[1];
}

test.describe('CISO portfolio journey (Epic O-4)', () => {
    test.describe.configure({ mode: 'serial' });

    test('A — login as CISO and land on the auto-provisioned AUDITOR tenant', async ({ page }) => {
        const slug = await loginAsCiso(page);
        // CISO's only seeded TenantMembership is acme-corp/AUDITOR.
        expect(slug).toBe(SEED_TENANT);

        // Role pill in the sidebar reflects the AUDITOR posture.
        await expect(
            page.locator('aside').getByText(/AUDITOR/i).first(),
        ).toBeVisible({ timeout: 15_000 });
    });

    // Titled "four stat cards" until the critical-risks tile went with
    // the risk register; the body has asserted three ever since.
    test('B — portfolio overview renders three stat cards + drill-down CTAs + tenant list', async ({ page }) => {
        await loginAsCiso(page);
        await safeGoto(page, `/org/${ORG_SLUG}`);

        await expect(
            page.getByRole('heading', { name: /Portfolio Overview/i }),
        ).toBeVisible({ timeout: 30_000 });

        // The stat cards are present and rendered. (The critical-risks
        // tile went with the risk register.)
        await expect(page.locator('#org-stat-coverage')).toBeVisible();
        await expect(page.locator('#org-stat-overdue-evidence')).toBeVisible();
        await expect(page.locator('#org-stat-tenants')).toBeVisible();

        // Drill-down + tenant coverage sections are present.
        await expect(page.locator('#org-drilldown-ctas')).toBeVisible();
        await expect(page.locator('#org-tenant-coverage')).toBeVisible();

        // The seeded acme-corp tenant is rendered as a clickable row.
        await expect(
            page.locator(`[data-testid="org-tenant-row-${SEED_TENANT}"]`).first(),
        ).toBeVisible({ timeout: 15_000 });
    });

    // GRC teardown phase 2 — test C ("practices drill-down lists rows
    // with tenant attribution") was deleted here. It drove
    // `/org/:slug/practices` and `#org-practices-table`, both removed
    // with the GRC surface, and its drill-through target
    // `/t/:slug/practices/:id` is gone too. See the docblock for why it
    // was not re-pointed onto the evidence drill-down (test E already
    // holds that assertion) and what coverage that costs.

    test('E — overdue evidence list renders with tenant attribution or empty state', async ({ page }) => {
        await loginAsCiso(page);
        await safeGoto(page, `/org/${ORG_SLUG}/evidence`);
        await expect(page.locator('#org-evidence-table')).toBeVisible({
            timeout: 30_000,
        });

        const hasRow = await page
            .locator('[data-testid^="org-evidence-tenant-"]')
            .first()
            .isVisible()
            .catch(() => false);
        const hasEmpty = await page
            .getByText(/No overdue evidence/i)
            .first()
            .isVisible()
            .catch(() => false);
        expect(hasRow || hasEmpty).toBe(true);
    });

    test('F — read-only invariant: AUDITOR cannot create tenant-level records', async ({ page }) => {
        await loginAsCiso(page);
        // GRC teardown phase 2 — was `/t/:slug/practices`; re-pointed to
        // `/t/:slug/assets`. The invariant is about the ROLE, not the
        // entity (it asserted on the risks page before that, and on
        // practices after), and `#new-asset-btn` in AssetsClient.tsx is
        // gated by the same `permissions.canWrite` flag `#new-practice-btn`
        // was.
        await safeGoto(page, `/t/${SEED_TENANT}/assets`);

        // Wait for the tenant chrome to come up.
        await expect(page.locator('aside').first()).toBeVisible({
            timeout: 30_000,
        });
        await page.waitForLoadState('networkidle').catch(() => { /* best-effort */ });

        // Sanity-check the page actually rendered its list before
        // concluding the button is absent — otherwise a blank error page
        // would satisfy the count-0 assertion vacuously.
        await expect(
            page.locator('[data-testid="assets-table"]'),
        ).toBeVisible({ timeout: 30_000 });

        // The create button is gated by `permissions.canWrite` —
        // AUDITOR never has it. Absence of the button is the read-only
        // proof.
        await expect(page.locator('#new-asset-btn')).toHaveCount(0);
    });

    test('G — CISO creates a 2nd tenant via /org/{slug}/tenants/new', async ({ page }) => {
        // Generate the slug INSIDE the test so each Playwright retry
        // gets a fresh value. Module-level UNIQUE persists across
        // retries within the same worker, and a retry would collide
        // with the slug the previous attempt already committed.
        const attemptUnique =
            Date.now().toString(36).slice(-6) +
            Math.floor(Math.random() * 1000).toString(36);
        const attemptSlug = `e2e-portfolio-${attemptUnique}`;
        const attemptName = `E2E Portfolio Tenant ${attemptUnique}`;

        await loginAsCiso(page);
        await safeGoto(page, `/org/${ORG_SLUG}/tenants/new`);

        await expect(
            page.locator('[data-testid="org-new-tenant-form"]'),
        ).toBeVisible({ timeout: 30_000 });

        await page.fill('[data-testid="org-new-tenant-name"]', attemptName);
        // The slug field auto-fills via a debounced effect after
        // name input. Wait for it to settle (any non-empty value),
        // THEN replace with a collision-proof slug. Without the
        // wait, the auto-fill can fire AFTER our `fill` call and
        // overwrite the collision-proof value back to a name-
        // derived slug — which collides with prior runs and the
        // create POST 409s. That race showed up as the test being
        // marked "flaky" in CI.
        const slugInput = page.locator('[data-testid="org-new-tenant-slug"]');
        await expect(slugInput).not.toHaveValue('', { timeout: 10_000 });
        await slugInput.fill(attemptSlug);
        // Re-assert after a short settle window — if a debounced
        // effect tries to overwrite the slug again, this fails
        // deterministically rather than producing a 409 later.
        await expect(slugInput).toHaveValue(attemptSlug, { timeout: 5_000 });
        // "Choose later" — keeps the post-create redirect to a stable
        // surface that doesn't depend on the framework catalog.
        await page.click('[data-testid="org-new-tenant-framework-later"]');

        await page.click('[data-testid="org-new-tenant-submit"]');

        // The form attempts to redirect to /t/{newSlug}/dashboard. The
        // user's in-flight JWT doesn't carry the new OWNER membership
        // yet, so middleware bounces on /t/* — that's a known pre-Epic-
        // O-4 limitation. We only need to confirm the row was actually
        // created, which we verify on the org tenants list.
        await page.waitForURL(/\/(?:t|org|no-tenant|tenants)\b/, { timeout: 30_000 }).catch(() => {
            /* the URL may settle on an error or picker — fine */
        });

        await safeGoto(page, `/org/${ORG_SLUG}/tenants`);
        await expect(page.locator('#org-tenants-table')).toBeVisible({
            timeout: 30_000,
        });
        await expect(
            page.locator(`[data-testid="org-tenant-link-${attemptSlug}"]`),
        ).toBeVisible({ timeout: 15_000 });
    });

    test('H — OrgSwitcher pivots from portfolio context into a tenant workspace', async ({ page }) => {
        await loginAsCiso(page);
        await safeGoto(page, `/org/${ORG_SLUG}`);

        // Sidebar must be hydrated before the popover trigger fires.
        await waitForHydration(page, 'aside').catch(() => {
            /* best-effort */
        });

        const trigger = page
            .locator('[data-testid="org-switcher-trigger"]')
            .first();
        await expect(trigger).toBeVisible({ timeout: 15_000 });
        await trigger.click();

        await expect(
            page.locator('[data-testid="org-switcher-portfolio"]').first(),
        ).toBeVisible({ timeout: 10_000 });

        const tenantRow = page
            .locator(`[data-testid="org-switcher-tenant-${SEED_TENANT}"]`)
            .first();
        await expect(tenantRow).toBeVisible({ timeout: 15_000 });

        await tenantRow.click();
        await page.waitForURL(
            new RegExp(`/t/${SEED_TENANT}/dashboard`),
            { timeout: 30_000 },
        );
        await expect(page.locator('aside').first()).toBeVisible({
            timeout: 30_000,
        });
    });
});
