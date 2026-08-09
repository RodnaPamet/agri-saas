/**
 * Practices Center — mutating E2E.
 *
 * Isolation: each `test()` runs against its own fresh, empty tenant
 * via the `isolatedTenant` fixture (see `./fixtures`). A test that
 * needs a pre-existing practice creates one in its own body — no
 * resource id is carried across tests in a module-level `let`, so a
 * failed setup step degrades to a single red test instead of
 * cascading through the file.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { loginAndGetTenant } from './e2e-utils';

/** Seed-tenant READER — only used by the read-only role-gate test below. */
const READER_USER = { email: 'viewer@acme.com', password: 'password123' };

/**
 * Create a practice on the current (isolated) tenant and return its
 * detail-page path. Self-contained setup helper so every test that
 * needs a practice mints its own — nothing is shared across tests.
 */
async function createPractice(page: Page, slug: string): Promise<string> {
    const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    await page.goto(`/t/${slug}/practices/new`);
    await page.waitForSelector('#practice-name-input', { timeout: 15000 });
    await page.fill('#practice-name-input', `E2E Practice ${uid}`);
    await page.fill('#practice-code-input', `CTRL-${uid}`);
    await page.fill('#practice-description-input', 'Test practice from e2e');
    await page.click('#create-practice-btn');
    await page.waitForSelector('#practice-title', { timeout: 15000 });
    return new URL(page.url()).pathname;
}

test.describe('Practices Center', () => {
    test('practices list page loads with filters and CTAs', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const { tenantSlug } = isolatedTenant;
        await authedPage.goto(`/t/${tenantSlug}/practices`);
        await authedPage.waitForLoadState('networkidle').catch(() => {});
        await authedPage.waitForSelector('h1', { timeout: 15000 });
        await expect(authedPage.locator('#new-practice-btn')).toBeVisible({ timeout: 5000 });
        // R14 (#443) removed the FilterToolbar text-search input from every
        // list page — no `#practice-search` element to assert.
        // Epic 53: the per-field `#practice-status-filter` dropdown has been
        // replaced by the consolidated FilterSelect picker.
        await expect(
            authedPage.getByRole('button', { name: /filter/i }).first(),
        ).toBeVisible();
    });

    test('create a new practice and see detail', async ({ authedPage, isolatedTenant }) => {
        const { tenantSlug } = isolatedTenant;
        const uid = Date.now().toString(36);
        await authedPage.goto(`/t/${tenantSlug}/practices/new`);
        await authedPage.waitForSelector('#practice-name-input', { timeout: 10000 });

        await authedPage.fill('#practice-name-input', `E2E Practice ${uid}`);
        await authedPage.fill('#practice-code-input', `CTRL-${uid}`);
        await authedPage.fill('#practice-description-input', 'Test practice from e2e');
        await authedPage.click('#create-practice-btn');

        await authedPage.waitForSelector('#practice-title', { timeout: 15000 });
        await expect(authedPage.locator('#practice-title')).toContainText(
            `E2E Practice ${uid}`,
            { timeout: 5000 },
        );
        await expect(authedPage.locator('#practice-status')).toBeVisible();
    });

    test('open practice → create task via the unified modal → appears in linked tasks', async ({ authedPage, isolatedTenant }) => {
        const { tenantSlug } = isolatedTenant;
        // Self-contained: create the practice this test operates on.
        await createPractice(authedPage, tenantSlug);
        const uid = Date.now().toString(36);
        const title = `E2E Task ${uid}`;

        // Go to tasks tab — task creation uses the canonical NewTaskModal
        // (via the shared LinkedTasksPanel), and the created compliance
        // task lands in the practice's linked-tasks table. (The retired
        // /tasks global list once verified here is gone; the farm-tasks
        // queue only surfaces FARM_TASK / FIELD_OPERATION rows, so a
        // practice-linked TASK is asserted at the practice, not there.)
        await authedPage.click('#tab-tasks');
        await authedPage.waitForSelector('#linked-task-create-btn', { timeout: 5000 });
        await authedPage.click('#linked-task-create-btn');

        // Canonical NewTaskModal — same fields as the Tasks page.
        await authedPage.waitForSelector('#task-title-input', { timeout: 5000 });
        await authedPage.fill('#task-title-input', title);
        await Promise.all([
            authedPage.waitForResponse(
                resp => /\/tasks(\?|$)/.test(resp.url()) && resp.request().method() === 'POST',
                { timeout: 15000 },
            ),
            authedPage.click('#create-task-btn'),
        ]);

        // The new task shows in the practice's linked-tasks table.
        // (The Tasks tab is a DataTable — rows no longer carry a per-row
        // `linked-task-<id>` id, so assert on the row text within the
        // table itself.)
        await expect(
            authedPage
                .locator('[data-testid="linked-tasks-table"]')
                .getByText(title),
        ).toBeVisible({ timeout: 15000 });
    });

    test('attach evidence → see it listed', async ({ authedPage, isolatedTenant }) => {
        const { tenantSlug } = isolatedTenant;
        const practiceDetailPath = await createPractice(authedPage, tenantSlug);
        await authedPage.goto(practiceDetailPath);
        await authedPage.waitForSelector('#practice-title', { timeout: 15000 });

        // Go to evidence tab
        await authedPage.click('#tab-evidence');
        await authedPage.waitForSelector('#link-evidence-btn', { timeout: 5000 });

        // Link evidence
        await authedPage.click('#link-evidence-btn');
        await authedPage.waitForSelector('#evidence-url-input', { timeout: 5000 });
        await authedPage.fill(
            '#evidence-url-input',
            'https://docs.example.com/evidence-report',
        );
        await authedPage.fill('#evidence-note-input', 'E2E evidence note');
        await Promise.all([
            authedPage.waitForResponse(
                resp =>
                    resp.url().includes('/evidence') && resp.request().method() === 'POST',
                { timeout: 10000 },
            ),
            authedPage.click('#submit-evidence-btn'),
        ]);

        await expect(authedPage.locator('#evidence-table')).toContainText(
            'docs.example.com',
            { timeout: 10000 },
        );
    });

    test('mark NOT_APPLICABLE requires justification', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const { tenantSlug } = isolatedTenant;
        const practiceDetailPath = await createPractice(authedPage, tenantSlug);
        await authedPage.goto(practiceDetailPath);
        await authedPage.waitForSelector('#practice-title', { timeout: 15000 });

        // Click applicability toggle
        await authedPage.click('#toggle-applicability-btn');
        await authedPage.waitForSelector('input[value="NOT_APPLICABLE"]', { timeout: 5000 });

        // Select Not Applicable
        await authedPage.click('input[value="NOT_APPLICABLE"]');
        await authedPage.waitForSelector('#applicability-justification', { timeout: 3000 });

        // Try to save without justification -> button should be disabled
        const saveBtn = authedPage.locator('#save-applicability-btn');
        await expect(saveBtn).toBeDisabled();

        // Fill justification and save — wait for the API response
        await authedPage.fill(
            '#applicability-justification',
            'Not in scope for this compliance cycle',
        );
        await expect(saveBtn).toBeEnabled();
        await Promise.all([
            authedPage.waitForResponse(
                resp =>
                    resp.url().includes('/applicability') &&
                    resp.request().method() === 'POST',
                { timeout: 15000 },
            ),
            saveBtn.click(),
        ]);

        await expect(authedPage.locator('#practice-applicability')).toContainText(
            'Not Applicable',
            { timeout: 10000 },
        );
    });

    // Read-only role-gate check — kept on the SHARED seeded tenant on
    // purpose. The `isolatedTenant` factory only ever provisions an
    // OWNER, so it cannot exercise a READER. This test logs in as the
    // seeded `viewer@acme.com` READER and only navigates + asserts —
    // it never writes, so it cannot pollute the shared tenant.
    test('reader user sees view-only practices', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, READER_USER);
        await page.goto(`/t/${tenantSlug}/practices`);
        await page.waitForSelector('h1', { timeout: 10000 });

        // Reader should NOT see create buttons.
        await expect(page.locator('#new-practice-btn')).not.toBeVisible({ timeout: 3000 });
    });
});
