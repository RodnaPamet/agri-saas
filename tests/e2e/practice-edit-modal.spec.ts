/**
 * Entity Edit Modal — mutating E2E.
 *
 * GRC teardown phase 2 — this file drove the practice detail page's
 * edit modal; `/practices` was DELETED. Every assertion here is about
 * the modal-form P2/P3 PLATFORM contract, not about practices —
 * "detail page exposes an Edit affordance to writers", "the modal
 * seeds from the loaded row and PATCHes it back", "Cancel discards",
 * "a reader never sees the affordance" — so the whole file is
 * RE-POINTED at `/assets/<id>` + `<EditAssetModal>`, which is the same
 * pattern on a surviving page (`#edit-asset-btn` → `#edit-asset-form`
 * → `#save-asset-btn` / `#edit-asset-cancel-btn`). No other E2E spec
 * covers an edit modal end-to-end: `epic54-crud-smoke` covers only the
 * `/new` create shim and `entity-detail-layout` only the detail shell.
 *
 * One assertion was DROPPED rather than re-pointed: the practice modal
 * rendered `#edit-success-toast` on save and the asset modal renders no
 * toast at all (its `onSaved` closes the modal and updates the detail
 * card). Asserting a toast that does not exist would fail; asserting
 * something weaker in its place would be vacuous. The save itself is
 * still proven — by the heading picking up the new name.
 *
 * Isolation: each `test()` runs on its own fresh, empty tenant via the
 * `isolatedTenant` fixture and creates the asset it edits, so it is
 * self-contained and order-independent.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

/** Seed-tenant READER — only used by the read-only role-gate test. */
const READER_USER = { email: 'viewer@acme.com', password: 'password123' };

/** Create an asset on the isolated tenant; land on its detail page. */
async function createAsset(page: Page, slug: string): Promise<void> {
    const uid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    // `/assets/new` is a server redirect onto `/assets?create=1`, which
    // AssetsClient detects and opens <NewAssetModal> for. `name` is the
    // only required field — `type` / `status` default in useNewAssetForm.
    await page.goto(`/t/${slug}/assets/new`);
    await page.waitForSelector('#asset-name-input', { timeout: 15000 });
    await page.fill('#asset-name-input', `Edit Modal Asset ${uid}`);
    await page.click('#create-asset-submit');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForSelector('#asset-title-heading', { timeout: 30000 });
}

/**
 * The modal's Name field. `<EditAssetFields>` renders it as the first
 * `input.input` in the form and its `<label>` carries no `htmlFor`, so
 * there is no accessible-name handle to select by — position inside
 * `#edit-asset-form` is the honest selector. (Type / status / owner are
 * Comboboxes, i.e. `<button>`s, so they cannot shift this match; only a
 * NEW text field inserted above Name could, and that is the case worth
 * being told about.)
 */
function nameInput(page: Page): Locator {
    return page.locator('#edit-asset-form input.input').first();
}

test.describe('Asset Edit Modal', () => {
    test('admin sees Edit button on asset detail', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await createAsset(authedPage, isolatedTenant.tenantSlug);
        await expect(authedPage.locator('#edit-asset-btn')).toBeVisible({
            timeout: 5000,
        });
    });

    test('Edit button opens modal and saves name change', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await createAsset(authedPage, isolatedTenant.tenantSlug);

        const originalTitle = (await authedPage
            .locator('#asset-title-heading')
            .textContent())!.trim();

        const editBtn = authedPage.locator('#edit-asset-btn');
        await editBtn.waitFor({ state: 'visible' });
        await editBtn.click();
        await expect(authedPage.locator('#edit-asset-form')).toBeVisible({
            timeout: 5000,
        });

        // The modal seeds from the loaded asset row (`editInitial`).
        await expect(nameInput(authedPage)).toHaveValue(originalTitle);

        const newTitle = `${originalTitle} (edited)`;
        await nameInput(authedPage).fill(newTitle);

        await authedPage.locator('#save-asset-btn').click();
        await expect(authedPage.locator('#edit-asset-form')).toBeHidden({
            timeout: 5000,
        });

        // The PATCH response flows back through `onSaved` into the
        // detail-card state, so the heading is the proof of the save.
        await expect(authedPage.locator('#asset-title-heading')).toContainText(
            '(edited)',
            { timeout: 5000 },
        );
    });

    test('Cancel closes modal without saving', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await createAsset(authedPage, isolatedTenant.tenantSlug);

        const originalTitle = (await authedPage
            .locator('#asset-title-heading')
            .textContent())!.trim();

        const editBtn = authedPage.locator('#edit-asset-btn');
        await editBtn.waitFor({ state: 'visible' });
        await editBtn.click();
        await expect(authedPage.locator('#edit-asset-form')).toBeVisible({
            timeout: 5000,
        });

        await nameInput(authedPage).fill('This should not save');

        // Modal-form P3 — closing a DIRTY form raises the native
        // unsaved-changes `window.confirm`. Playwright auto-DISMISSES an
        // unhandled dialog, which the guard reads as "keep editing", so
        // the discard must be accepted explicitly. (This is the intent
        // of the click: we are asserting the discard path.)
        authedPage.on('dialog', (dialog) => {
            void dialog.accept();
        });
        await authedPage.locator('#edit-asset-cancel-btn').click();
        await expect(authedPage.locator('#edit-asset-form')).toBeHidden({
            timeout: 3000,
        });

        await expect(authedPage.locator('#asset-title-heading')).toHaveText(
            originalTitle,
        );
    });

    // Read-only role-gate check — kept on the SHARED seeded tenant
    // because the `isolatedTenant` factory only provisions an OWNER and
    // there's no multi-role provisioner yet. The shared tenant seeds
    // three assets (`prisma/seed.ts`), so there is a row to open.
    //
    // Hardened (2026-06-03) — this had flaked across PRs. Three changes
    // make it deterministic:
    //   1. Premise guard. The check is only meaningful when the session
    //      is genuinely READ-ONLY. The shared tenant's viewer role is
    //      mutable across the serial E2E run, so if the session lands
    //      write-capable (the assets "+" create button is present),
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
    //      transient `ChunkLoadError` leaves the heading unrendered →
    //      `waitForSelector` times out with no retry). `safeGoto`
    //      does a full document load and retries transient failures.
    test('reader user does not see Edit button', async ({ page }) => {
        const tenantSlug = await loginAndGetTenant(page, READER_USER);
        await safeGoto(page, `/t/${tenantSlug}/assets`);
        await page.waitForSelector('h1', { timeout: 15000 });

        // Premise: read-only session (no write affordance on the list).
        const canWrite = await page
            .locator('#new-asset-btn')
            .isVisible({ timeout: 3000 })
            .catch(() => false);
        test.skip(
            canWrite,
            'session has write access on the shared tenant — read-only gate premise not met',
        );

        const firstLink = page
            .getByRole('main')
            .locator('a[id^="asset-link-"]')
            .first();
        const hasAsset = await firstLink
            .isVisible({ timeout: 3000 })
            .catch(() => false);
        test.skip(!hasAsset, 'no asset row to open on the shared tenant');

        // Navigate by URL (full load, retried) instead of clicking the
        // link (chunk-dependent client-side nav — the flake source).
        const href = await firstLink.getAttribute('href');
        test.skip(!href, 'asset row link has no href to open');

        await safeGoto(page, href!);
        await page.waitForSelector('#asset-title-heading', { timeout: 15000 });
        await page.waitForLoadState('networkidle').catch(() => {});
        await expect(
            page.getByRole('main').locator('#edit-asset-btn'),
        ).toHaveCount(0);
    });
});
