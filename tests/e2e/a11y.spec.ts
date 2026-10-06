/**
 * GAP-20 — Accessibility (axe-core) E2E.
 *
 * Scans the highest-traffic product surfaces with axe-core and
 * fails the test on `serious` or `critical` WCAG violations. Lower-
 * severity findings are reported (visible in the test annotation
 * + console) but do not gate CI today — the codebase is not yet
 * at zero-violations baseline, and we want a hard gate on the
 * highest-impact issues without flooring the suite on `moderate`
 * findings until they're triaged.
 *
 * SURFACES COVERED
 *
 * Unauthenticated:
 *   • /login                 — primary auth surface, every visitor
 *   • /no-tenant             — error/transition page (post-login,
 *                                pre-tenant-context)
 *
 * Authenticated (admin@acme.com → acme-corp):
 *   • /t/{slug}/dashboard    — landing page, dense KPI grid
 *   • /t/{slug}/assets       — list page (DataTable + filter shell)
 *   • /t/{slug}/evidence     — list page + uploads
 *   • /t/{slug}/farm-tasks   — list page (field work)
 *
 * Modal / interactive surfaces:
 *   • Create-asset modal opened from /assets
 *
 * GRC teardown phase 2 — the list-page and modal surfaces above were
 * /practices and its create-practice modal until that route was
 * deleted. Both are re-pointed at /assets rather than dropped: what
 * they scan is the shared PLATFORM chrome (ListPageShell +
 * FilterToolbar + DataTable for the list; the <Modal> primitive's
 * focus trap + labelling for the overlay), not anything specific to
 * the entity. /assets is the closest surviving equivalent — a seeded
 * DataTable list page whose create affordance is a <Modal>.
 *
 * AXE CONFIG
 *
 *   • Tags: `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`. WCAG 2.2
 *     rules tagged `wcag22aa` are ALSO enabled — they're a strict
 *     superset and any violation there is genuinely worth fixing.
 *
 *   • Disabled rules:
 *       — `region`: dashboards intentionally use sectioned cards
 *         without an outer <main> wrapper inside route segments
 *         (the AppShell layout owns the landmark structure). The
 *         rule fires on every section without an explicit role,
 *         which is noise here. Re-enable when AppShell exposes a
 *         single landmark per route.
 *
 *   • Severity gate: serious + critical violations FAIL the test.
 *     Minor and moderate are LOGGED for visibility but tolerated
 *     until baselined. The intention is to add them to the gate
 *     incrementally once each rule has been triaged across the
 *     surface.
 *
 * ADDING A NEW SURFACE
 *
 *   1. Add a new `test('...', ...)` block.
 *   2. Navigate to the page.
 *   3. Wait on a stable selector that's only present after the
 *      page has actually rendered (avoid `networkidle` — the test
 *      DB seed produces enough background activity to never fully
 *      idle).
 *   4. Call `runA11yScan(page, label)` — the helper handles the
 *      exclusion list, the assertion, and the actionable report.
 *
 * ── P2.9: the scan helper moved, the surfaces did not ──
 *
 * `runA11yScan` now lives in `./a11y-scan`, shared with
 * `tests/e2e/mobile/a11y-mobile.spec.ts`. This spec runs ONLY on the
 * `chromium` project (1280px), because `playwright.config.ts` gives the two
 * phone projects `grep: /@mobile/` — so for as long as this file has existed,
 * ZERO of its surfaces had ever been scanned at a phone viewport. Tagging
 * THIS file `@mobile` would have been the wrong fix: the desktop project's
 * `grepInvert: /@mobile/` would then have excluded it, trading one blind
 * viewport for the other.
 */
import { test, expect } from '@playwright/test';
import { safeGoto, loginAndGetTenant } from './e2e-utils';
import { runA11yScan } from './a11y-scan';


// ─── Unauthenticated surfaces ────────────────────────────────────

test.describe('a11y — unauthenticated', () => {
    test('login page has no critical/serious WCAG violations', async ({ page }) => {
        await safeGoto(page, '/login', { timeout: 60_000 });
        await page.waitForSelector('input[type="email"][name="email"]', { timeout: 60_000 });
        await runA11yScan(page, 'login');
    });

    test('no-tenant page has no critical/serious WCAG violations', async ({ page }) => {
        await safeGoto(page, '/no-tenant', { timeout: 60_000 });
        // /no-tenant is rendered by middleware in some flows and by a
        // page handler in others; assert on the heading text rather
        // than a specific selector path so both shapes pass.
        await page.waitForSelector('h1, h2', { timeout: 30_000 });
        await runA11yScan(page, 'no-tenant');
    });
});

// ─── Authenticated surfaces (admin@acme.com on acme-corp) ────────

test.describe('a11y — authenticated tenant pages', () => {
    let tenantSlug: string;

    test.beforeEach(async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
    });

    test('dashboard has no critical/serious WCAG violations', async ({ page }) => {
        await safeGoto(page, `/t/${tenantSlug}/dashboard`);
        // The farm-UI trim removed the KPI grid + masthead header; the
        // greeting card now carries the page's <h1>. Wait on that.
        await page.waitForSelector('h1', { timeout: 30_000 });
        await runA11yScan(page, 'dashboard');
    });

    // GRC teardown phase 2 — was `/practices`; re-pointed to `/assets`
    // (same DataTable + filter shell, seeded with three rows by
    // `prisma/seed.ts`). See the docblock.
    test('assets list has no critical/serious WCAG violations', async ({ page }) => {
        await safeGoto(page, `/t/${tenantSlug}/assets`);
        // DataTable mounts its <table> after data resolves; wait on
        // the table itself or a data-testid.
        await page.waitForSelector('table, [data-testid="assets-table"]', { timeout: 30_000 });
        await runA11yScan(page, 'assets list');
    });


    test('evidence list has no critical/serious WCAG violations', async ({ page }) => {
        await safeGoto(page, `/t/${tenantSlug}/evidence`);
        await page.waitForSelector('table, h1', { timeout: 30_000 });
        await runA11yScan(page, 'evidence list');
    });

    test('tasks list has no critical/serious WCAG violations', async ({ page }) => {
        await safeGoto(page, `/t/${tenantSlug}/farm-tasks`);
        await page.waitForSelector('table, [data-testid="farm-tasks-table"], h1', { timeout: 30_000 });
        await runA11yScan(page, 'farm tasks list');
    });

});

// ─── Modal / interactive surfaces ────────────────────────────────

test.describe('a11y — interactive overlays', () => {
    // GRC teardown phase 2 — was the create-practice modal on
    // `/practices`; re-pointed to the create-asset modal on `/assets`.
    // Both are the same `<Modal>` primitive rendered from a list page
    // header button, which is what this scan is about.
    test('create-asset modal has no critical/serious WCAG violations', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${tenantSlug}/assets`);
        await page.waitForSelector('table, [data-testid="assets-table"]', { timeout: 30_000 });

        // Open the create-asset modal via the canonical id selector
        // (`#new-asset-btn`, wired into AssetsClient.tsx). An id
        // selector rather than a text-/data-testid chain: the latter
        // raced the toolbar render in some seeded states, tripping a
        // conditional `test.skip` and leaving the surface uncovered.
        const newAssetBtn = page.locator('#new-asset-btn');
        await expect(newAssetBtn).toBeVisible({ timeout: 30_000 });
        await newAssetBtn.click();

        // Modal renders a dialog with role="dialog". Wait for it
        // before scanning so axe sees the trapped focus + modal DOM.
        await page.waitForSelector('[role="dialog"]', { timeout: 15_000 });

        await runA11yScan(page, 'create-asset modal');
    });
});
