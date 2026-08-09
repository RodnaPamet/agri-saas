import { test, expect } from '@playwright/test';
import { loginAndGetTenant } from './e2e-utils';

/**
 * DataTable Platform E2E — Validates that all migrated list pages render
 * consistently using the shared DataTable architecture.
 *
 * These tests do NOT test business logic (that's in entity-specific specs).
 * They test platform-level table behaviors:
 *   - Tables render with proper structure (thead/tbody/rows)
 *   - Column headers are visible
 *   - Empty states work
 *   - Loading doesn't crash
 *   - Row click navigation works
 *   - Filter interactions are wired
 *
 * This spec is the "one team owns the platform" regression net.
 */

test.describe('DataTable Platform — Cross-page regression', () => {
    let tenantSlug: string;

    // ── Helper: verify a list page renders a DataTable ───

    async function assertTableRendered(page: import('@playwright/test').Page, path: string, opts?: {
        heading?: string;
        testId?: string;
        minHeaders?: number;
    }) {
        await page.goto(`/t/${tenantSlug}${path}`);
        await page.waitForLoadState('networkidle').catch(() => {});

        // Wait for heading
        if (opts?.heading) {
            await expect(page.locator('h1')).toContainText(opts.heading, { timeout: 15000 });
        } else {
            await page.waitForSelector('h1', { timeout: 15000 });
        }

        // Verify table structure exists (DataTable renders <table> internally)
        const tableLocator = opts?.testId
            ? page.locator(`[data-testid="${opts.testId}"] table`)
            : page.locator('table').first();

        // Table might be empty — that's fine, but the structure should exist
        // unless there's genuinely no data (empty state shown instead).
        // Bumped from 5s → 15s: admin audit-log occasionally takes
        // longer than 5s on the first load (the audit-log API hits a
        // hash-chain integrity check before returning), and the
        // 5s budget produced a flake under load.
        const tableVisible = await tableLocator.isVisible({ timeout: 15000 }).catch(() => false);

        if (tableVisible) {
            // If table is visible, verify it has headers
            const headerCount = await tableLocator.locator('thead th').count();
            const minHeaders = opts?.minHeaders ?? 2;
            expect(headerCount).toBeGreaterThanOrEqual(minHeaders);
        } else {
            // Empty state should be visible when table has no data
            // DataTable renders <TableEmptyState> or custom emptyState prop
            const emptyVisible = await page.locator('text=/no .+ found|no .+ yet|no .+ match/i').isVisible({ timeout: 3000 }).catch(() => false);
            // Either table or empty state must be present
            expect(tableVisible || emptyVisible).toBe(true);
        }

        // Verify no legacy skeleton on the page
        const skeletonTableRow = await page.locator('.data-table tbody .animate-pulse').count();
        // After load, there should be no skeleton rows (DataTable handles loading internally)
        if (skeletonTableRow > 0) {
            // This is acceptable during loading transitions, but after networkidle should be 0
            // Allow a brief grace period for slow renders
            await page.waitForTimeout(1000);
            const afterWait = await page.locator('.data-table tbody .animate-pulse').count();
            expect(afterWait).toBe(0);
        }
    }

    // ── Controls ──

    test('Controls page renders DataTable', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await assertTableRendered(page, '/controls', {
            heading: 'Controls',
            minHeaders: 3,
        });
    });

    // ── Policies ──

    test('Policies page renders DataTable', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await assertTableRendered(page, '/policies', {
            heading: 'Polic',
            testId: 'policies-table',
            minHeaders: 3,
        });
    });

    // ── Tasks ──

    test('Tasks page renders DataTable', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await assertTableRendered(page, '/farm-tasks', {
            heading: 'Tasks',
            testId: 'farm-tasks-table',
            minHeaders: 4,
        });
    });

    // ── Vendors ──

    test('Vendors page renders DataTable', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await assertTableRendered(page, '/vendors', {
            heading: 'Vendor',
            testId: 'vendors-table',
            minHeaders: 3,
        });
    });

    // ── Assets ──

    test('Assets page renders DataTable', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await assertTableRendered(page, '/assets', {
            heading: 'Asset',
            testId: 'assets-table',
            minHeaders: 3,
        });
    });

    // ── Findings ──

    test('Findings page renders DataTable', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await assertTableRendered(page, '/findings', {
            // Reseated: findings.title → "Nonconformity Register" (ag vocabulary).
            heading: 'Nonconformity',
            testId: 'findings-table',
            minHeaders: 3,
        });
    });

    // ── Evidence ──

    test('Evidence page renders DataTable', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await assertTableRendered(page, '/evidence', {
            // Reseated: evidence.title → "Records" (ag vocabulary).
            heading: 'Records',
            minHeaders: 3,
        });
    });

    // ── Admin Audit Log ──
    // R13-PR10 — audit log was extracted to its own page
    // (`/admin/audit-log`) reachable via the "Audit log" pill on
    // the admin landing. The data-testid + DataTable contract is
    // preserved; only the URL changed.

    test('Admin audit log renders DataTable', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await assertTableRendered(page, '/admin/audit-log', {
            testId: 'audit-log-table',
            minHeaders: 3,
        });
    });
});

test.describe('DataTable Platform — Row click navigation', () => {
    let tenantSlug: string;

    test('Controls row double-click navigates to detail', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await page.goto(`/t/${tenantSlug}/controls`);
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForSelector('h1', { timeout: 15000 });

        // R13-PR2 — row opens on double-click, not single-click.
        // Seed provisions 4 tenant controls; assert visibility.
        // Target the second visible cell (the code cell), which is
        // not interactive — DataTable ignores double-clicks landing
        // on interactive children like the select checkbox or title
        // link.
        const rows = page.locator('tbody tr');
        await expect(rows.first()).toBeVisible({ timeout: 15_000 });

        await rows.first().locator('td').nth(1).dblclick();
        await page.waitForURL(/\/controls\/[a-zA-Z0-9-]+$/, { timeout: 10_000 });
        await expect(page.locator('#control-title')).toBeVisible({ timeout: 10_000 });
    });

    test('Policies row double-click navigates to detail', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await page.goto(`/t/${tenantSlug}/policies`);
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForSelector('h1', { timeout: 15000 });

        // R13-PR2 — row opens on double-click, not single-click.
        // Seed provisions 3 published policies.
        const rows = page.locator('[data-testid="policies-table"] tbody tr');
        await expect(rows.first()).toBeVisible({ timeout: 15_000 });

        await rows.first().dblclick();
        await page.waitForURL(/\/policies\/[a-zA-Z0-9-]+$/, { timeout: 10_000 });
    });
});

// R14 (#443) removed the FilterToolbar text-search input from every list
// page (the navbar ⌘K palette is the sole search affordance now). The
// "Filter interaction" describe block here drove `#control-search` /
// `#task-search` directly and was deleted — list-page filter coverage
// now lives in `controls-filter-epic53.spec.ts` (the FilterSelect popover
// path, which is the surviving filter UI).
