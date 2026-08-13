/**
 * Entity → Evidence linking — mutating E2E.
 *
 * GRC teardown phase 2 — this file drove the practice detail page's
 * Evidence tab; `/practices` was DELETED. Nothing it asserts is
 * practice-specific: the subject is the SHARED evidence surface
 * (`<AttachedEvidencePanel>` → `<EvidenceAddForm>` + `<EvidenceSubTable>`),
 * which the asset detail page mounts unchanged — the panel names its
 * element ids off its `entity` prop, so `#practice-evidence-form`
 * becomes `#asset-evidence-form`, `#link-evidence-btn` becomes
 * `#add-asset-evidence-btn`, and `#evidence-table` / `#no-evidence`
 * are literally the same ids (see the E2E-contract comment in
 * `src/components/EvidenceSubTable.tsx`). So the whole file is
 * RE-POINTED at `/assets/<id>` rather than deleted.
 *
 * Complementary to `core-flow.spec.ts`, which covers the FILE-upload
 * half of the same tab: this file covers the empty state, the URL-link
 * path, the form offering both inputs, and the Epic 67 undo-toast
 * removal.
 *
 * Isolation: every `test()` runs on its own fresh, empty tenant via
 * the `isolatedTenant` fixture. Each test mints the asset (and, where
 * needed, the linked evidence) it operates on inside its own body — no
 * detail path is carried across tests in a module-level `let`. A
 * failed setup degrades to one red test instead of cascading through
 * the whole file.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/** Create an asset on the isolated tenant; return its detail path. */
async function createAsset(page: Page, slug: string): Promise<string> {
    const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    // `/assets/new` is a server redirect onto `/assets?create=1`, which
    // AssetsClient detects and opens <NewAssetModal> for. `name` is the
    // only required field — `type` / `status` default in useNewAssetForm.
    await page.goto(`/t/${slug}/assets/new`);
    await page.waitForSelector('#asset-name-input', { timeout: 15000 });
    await page.fill('#asset-name-input', `Evidence Test ${uid}`);
    await page.click('#create-asset-submit');
    await page.waitForSelector('#asset-title-heading', { timeout: 60000 });
    return new URL(page.url()).pathname;
}

/** Link a URL evidence record on the open asset's Evidence tab. */
async function linkUrlEvidence(page: Page, note: string): Promise<void> {
    await page.click('#tab-evidence');
    await page.click('#add-asset-evidence-btn');
    await page.fill('#asset-evidence-url', 'https://example.com/evidence-doc');
    await page.fill('#asset-evidence-note', note);
    await page.click('#submit-asset-evidence-btn');
    await expect(page.locator('#evidence-table')).toBeVisible({ timeout: 10000 });
}

test.describe('Asset → Evidence Linking', () => {
    test('create asset for evidence linking', async ({ authedPage, isolatedTenant }) => {
        const uid = Date.now().toString(36);
        await authedPage.goto(`/t/${isolatedTenant.tenantSlug}/assets/new`);
        await authedPage.waitForSelector('#asset-name-input', { timeout: 15000 });

        await authedPage.fill('#asset-name-input', `Evidence Test ${uid}`);
        await authedPage.click('#create-asset-submit');
        await authedPage.waitForSelector('#asset-title-heading', { timeout: 60000 });
        await expect(authedPage.locator('#asset-title-heading')).toContainText(
            `Evidence Test ${uid}`,
        );
    });

    test('evidence tab starts empty', async ({ authedPage, isolatedTenant }) => {
        const assetDetailPath = await createAsset(
            authedPage,
            isolatedTenant.tenantSlug,
        );
        await authedPage.goto(assetDetailPath);
        await authedPage.waitForSelector('#asset-title-heading', { timeout: 15000 });

        await authedPage.click('#tab-evidence');
        await expect(authedPage.locator('#no-evidence')).toBeVisible({ timeout: 5000 });
    });

    test('link URL evidence from asset context', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const uid = Date.now().toString(36);
        const assetDetailPath = await createAsset(
            authedPage,
            isolatedTenant.tenantSlug,
        );
        await authedPage.goto(assetDetailPath);
        await authedPage.waitForSelector('#asset-title-heading', { timeout: 15000 });

        await authedPage.click('#tab-evidence');
        await authedPage.click('#add-asset-evidence-btn');
        await authedPage.fill('#asset-evidence-url', 'https://example.com/evidence-doc');
        await authedPage.fill('#asset-evidence-note', `Test link ${uid}`);
        await authedPage.click('#submit-asset-evidence-btn');

        // `linkAssetEvidence` writes an Evidence row of type LINK whose
        // `content` is the URL, so the row renders a LINK badge and the
        // URL itself as the title cell's href text.
        await expect(authedPage.locator('#evidence-table')).toBeVisible({ timeout: 10000 });
        await expect(authedPage.locator('#evidence-table')).toContainText('LINK');
        await expect(authedPage.locator('#evidence-table')).toContainText(
            'https://example.com/evidence-doc',
        );
    });

    test('the + Evidence form offers both file upload and URL link', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const assetDetailPath = await createAsset(
            authedPage,
            isolatedTenant.tenantSlug,
        );
        await authedPage.goto(assetDetailPath);
        await authedPage.waitForSelector('#asset-title-heading', { timeout: 15000 });

        await authedPage.click('#tab-evidence');
        // The separate "Upload Evidence" button was merged into "+ Evidence".
        await authedPage.click('#add-asset-evidence-btn');
        await expect(authedPage.locator('#asset-evidence-form')).toBeVisible({
            timeout: 5000,
        });
        // File-upload section (browse + title) now lives in this one form…
        await expect(authedPage.locator('#asset-evidence-file')).toBeVisible();
        await expect(authedPage.locator('#asset-evidence-title')).toBeVisible();
        // …alongside the URL-link section.
        await expect(authedPage.locator('#asset-evidence-url')).toBeVisible();
    });

    test('unlink evidence removes it from tab', async ({
        authedPage,
        isolatedTenant,
    }) => {
        const uid = Date.now().toString(36);
        const assetDetailPath = await createAsset(
            authedPage,
            isolatedTenant.tenantSlug,
        );
        await authedPage.goto(assetDetailPath);
        await authedPage.waitForSelector('#asset-title-heading', { timeout: 15000 });

        // This test needs a row to unlink — create one first.
        await linkUrlEvidence(authedPage, `Test link ${uid}`);

        // Count rows before
        const rowsBefore = await authedPage
            .locator('#evidence-table tbody tr')
            .count();
        expect(rowsBefore).toBeGreaterThan(0);

        // Click the first remove button. `<EvidenceSubTable>` passes
        // `selectionEnabled={false}` precisely so this matches the
        // unlink control and not a row checkbox.
        const removeBtn = authedPage
            .locator('#evidence-table tbody tr button')
            .first();
        await removeBtn.click();

        // Epic 67 — the removal is optimistic (the commit fires after
        // the undo window), so the row leaves the table immediately.
        await expect(async () => {
            const rowsAfter = await authedPage
                .locator('#evidence-table tbody tr')
                .count();
            expect(rowsAfter).toBeLessThan(rowsBefore);
        }).toPass({ timeout: 15000 });
    });
});
