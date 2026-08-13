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

    // GRC teardown phase 2 — the Practices and Policies list tests were
    // deleted with `/practices` and `/policies`. They asserted nothing
    // about those entities that the surviving pages below do not also
    // assert (this describe block is deliberately entity-agnostic — it
    // tests the shared DataTable, not the domain), so the platform
    // contract is still covered by Tasks / Assets / Evidence / audit-log.

    // ── Tasks ──

    test('Tasks page renders DataTable', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await assertTableRendered(page, '/farm-tasks', {
            heading: 'Tasks',
            testId: 'farm-tasks-table',
            minHeaders: 4,
        });
    });

    // GRC teardown phase 2 — the Vendors test went with `/vendors`.

    // ── Assets ──

    test('Assets page renders DataTable', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await assertTableRendered(page, '/assets', {
            heading: 'Asset',
            testId: 'assets-table',
            minHeaders: 3,
        });
    });

    // GRC teardown phase 2 — the Findings test went with `/findings`
    // (the "Nonconformity Register" reseat did not survive the uproot).

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

    // GRC teardown phase 2 — the two cases here drove `/practices` and
    // `/policies`. The assertion is about the PLATFORM (R13-PR2:
    // selection owns the single click, so the row action moves to
    // double-click), not about either entity, so both were re-pointed
    // at surviving seeded list pages rather than dropped: Assets and
    // farm Tasks. Both wire `onRowClick` and leave `selectionEnabled`
    // at its `true` default, which is exactly the configuration that
    // puts navigation on the double-click.

    test('Assets row double-click navigates to detail', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await page.goto(`/t/${tenantSlug}/assets`);
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForSelector('h1', { timeout: 15000 });

        // Seed provisions 3 tenant assets.
        const rows = page.getByRole('main').locator('[data-testid="assets-table"] tbody tr');
        await expect(rows.first()).toBeVisible({ timeout: 15_000 });

        // Target the LAST cell — DataTable's trailing chevron column,
        // which it appends whenever `onRowClick` is wired. Its contents
        // are `aria-hidden` decoration with `pointer-events-none`, so
        // the double-click always lands on the `<td>` itself and never
        // on an interactive child (the select checkbox in the leading
        // cell, or the title `<Link>` in the name cell — DataTable
        // ignores double-clicks on both). Using `.last()` rather than a
        // fixed index also survives the Code column being hidden by
        // default, which would shift every positional index by one.
        await rows.first().locator('td').last().dblclick();
        await page.waitForURL(/\/assets\/[a-zA-Z0-9-]+$/, { timeout: 10_000 });
        await expect(page.locator('#asset-title-heading')).toBeVisible({ timeout: 10_000 });
    });

    test('Tasks row double-click navigates to detail', async ({ page }) => {
        tenantSlug = await loginAndGetTenant(page);
        await page.goto(`/t/${tenantSlug}/farm-tasks`);
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForSelector('h1', { timeout: 15000 });

        // Seed provisions 4 tenant tasks.
        const rows = page.getByRole('main').locator('[data-testid="farm-tasks-table"] tbody tr');
        await expect(rows.first()).toBeVisible({ timeout: 15_000 });

        await rows.first().locator('td').last().dblclick();
        await page.waitForURL(/\/farm-tasks\/[a-zA-Z0-9-]+$/, { timeout: 10_000 });
        await expect(page.locator('#task-title')).toBeVisible({ timeout: 10_000 });
    });
});

// R14 (#443) removed the standalone FilterToolbar text-search input from
// every list page. The "Filter interaction" describe block here drove
// `#practice-search` / `#task-search` directly and was deleted — the
// surviving filter UI is the FilterSelect popover, covered by
// `filters.spec.ts` (URL-param contract) and `search-affordances.spec.ts`
// (the live content search that now lives inside that popover).
//
// GRC teardown phase 2 — the earlier pointer here was to
// `practices-filter-epic53.spec.ts`, which went with `/practices`.
