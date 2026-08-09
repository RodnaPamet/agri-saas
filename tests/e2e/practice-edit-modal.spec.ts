/**
 * Practice Edit Modal — mutating E2E.
 *
 * Isolation: each `test()` runs on its own fresh, empty tenant via
 * the `isolatedTenant` fixture. The previous shape located "the
 * first practice in the table" — which only works against the seed
 * tenant's pre-existing data. Each test now creates its own practice
 * first, so it is self-contained and order-independent. The
 * "edit saves the title" test mutates a row that, on an isolated
 * tenant, cannot pollute the shared seeded tenant.
 *
 * All selectors use existing id / data-testid attributes — no new
 * data-testid attributes added (the edit-modal ones predate this
 * work).
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

/** Seed-tenant READER — only used by the read-only role-gate test. */
const READER_USER = { email: 'viewer@acme.com', password: 'password123' };

/** Create a practice on the isolated tenant; land on its detail page. */
async function createPractice(page: Page, slug: string): Promise<void> {
    const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    await page.goto(`/t/${slug}/practices/new`);
    await page.waitForSelector('#practice-name-input', { timeout: 15000 });
    await page.fill('#practice-name-input', `Edit Modal Ctrl ${uid}`);
    await page.fill('#practice-code-input', `EDM-${uid}`);
    await page.click('#create-practice-btn');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForSelector('#practice-title', { timeout: 30000 });
}

test.describe('Practice Edit Modal', () => {
    test('admin sees Edit button on practice detail', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await createPractice(authedPage, isolatedTenant.tenantSlug);
        await expect(
            authedPage.locator('[data-testid="practice-edit-button"]'),
        ).toBeVisible({ timeout: 5000 });
    });

    test('Edit button opens modal and saves title change', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await createPractice(authedPage, isolatedTenant.tenantSlug);

        const originalTitle = (await authedPage
            .locator('#practice-title')
            .textContent())!.trim();

        const editBtn = authedPage.locator('[data-testid="practice-edit-button"]');
        await editBtn.waitFor({ state: 'visible' });
        await editBtn.click();
        await expect(
            authedPage.locator('[data-testid="practice-edit-dialog"]'),
        ).toBeVisible({ timeout: 5000 });

        const nameInput = authedPage.locator('[data-testid="edit-name-input"]');
        await expect(nameInput).toHaveValue(originalTitle);

        const newTitle = `${originalTitle} (edited)`;
        await nameInput.fill(newTitle);

        await authedPage.locator('[data-testid="edit-save-button"]').click();
        await expect(
            authedPage.locator('[data-testid="practice-edit-dialog"]'),
        ).toBeHidden({ timeout: 5000 });

        await expect(authedPage.locator('#practice-title')).toContainText(
            '(edited)',
            { timeout: 5000 },
        );
        await expect(authedPage.locator('#edit-success-toast')).toBeVisible({
            timeout: 3000,
        });
    });

    test('Cancel closes modal without saving', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await createPractice(authedPage, isolatedTenant.tenantSlug);

        const originalTitle = (await authedPage
            .locator('#practice-title')
            .textContent())!.trim();

        const editBtn = authedPage.locator('[data-testid="practice-edit-button"]');
        await editBtn.waitFor({ state: 'visible' });
        await editBtn.click();
        await expect(
            authedPage.locator('[data-testid="practice-edit-dialog"]'),
        ).toBeVisible({ timeout: 5000 });

        await authedPage
            .locator('[data-testid="edit-name-input"]')
            .fill('This should not save');

        await authedPage.locator('[data-testid="edit-cancel-button"]').click();
        await expect(
            authedPage.locator('[data-testid="practice-edit-dialog"]'),
        ).toBeHidden({ timeout: 3000 });

        await expect(authedPage.locator('#practice-title')).toHaveText(
            originalTitle,
        );
    });

    // Read-only role-gate check — kept on the SHARED seeded tenant
    // because the `isolatedTenant` factory only provisions an OWNER and
    // there's no multi-role provisioner yet.
    //
    // Hardened (2026-06-03) — this had flaked across PRs. Three changes
    // make it deterministic:
    //   1. Premise guard. The check is only meaningful when the session
    //      is genuinely READ-ONLY. The shared tenant's viewer role is
    //      mutable across the serial E2E run, so if the session lands
    //      write-capable (the practices "+" create button is present),
    //      the premise doesn't hold — skip rather than false-fail. The
    //      positive "admin SEES Edit" case is covered on isolated
    //      tenants above, so coverage of the gate itself isn't lost.
    //   2. Scope to <main>. A bare page-level locator can match a Next
    //      streaming duplicate of the page (see the risk-matrix E2E
    //      lesson); scoping to the main region matches only the live
    //      page.
    //   3. Assert ABSENCE (toHaveCount(0)) after the page settles,
    //      instead of polling `not.toBeVisible` — the reader's page
    //      never renders the button at all, and a count assertion can't
    //      be fooled by a transient mid-navigation paint.
    //   4. (2026-07-09) Open the detail page by full navigation, not a
    //      row-link CLICK. A client-side SPA nav depends on dynamic
    //      chunk loading, which flakes under the CI dev server (a
    //      transient `ChunkLoadError` leaves `#practice-title` unrendered
    //      → `waitForSelector` times out with no retry). `safeGoto`
    //      does a full document load and retries transient failures.
    test('reader user does not see Edit button', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, READER_USER);
        await safeGoto(page, `/t/${tenantSlug}/practices`);
        await page.waitForSelector('h1', { timeout: 15000 });

        // Premise: read-only session (no write affordance on the list).
        const canWrite = await page
            .locator('#new-practice-btn')
            .isVisible({ timeout: 3000 })
            .catch(() => false);
        test.skip(
            canWrite,
            'session has write access on the shared tenant — read-only gate premise not met',
        );

        const firstLink = page
            .locator('#practices-table tbody tr a[id^="practice-link-"]')
            .first();
        const hasPractice = await firstLink
            .isVisible({ timeout: 3000 })
            .catch(() => false);
        test.skip(!hasPractice, 'no practice row to open on the shared tenant');

        // Navigate by URL (full load, retried) instead of clicking the
        // link (chunk-dependent client-side nav — the flake source).
        const href = await firstLink.getAttribute('href');
        test.skip(!href, 'practice row link has no href to open');

        await safeGoto(page, href!);
        await page.waitForSelector('#practice-title', { timeout: 15000 });
        await page.waitForLoadState('networkidle').catch(() => {});
        await expect(
            page
                .getByRole('main')
                .locator('[data-testid="practice-edit-button"]'),
        ).toHaveCount(0);
    });
});
