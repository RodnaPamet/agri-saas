/**
 * Exchange write flows (Prompt 3) — create an offer.
 *
 * Verifies the header "Offer" button opens the create modal without
 * navigation, and that a full submit POSTs a new listing. Isolation: each
 * test runs on its own fresh tenant (isolatedTenant), which has the EXCHANGE
 * module available (a tenant with no module-settings row gets all modules).
 * The map is a bespoke 2D <canvas> renderer (NOT MapLibre, and so no
 * third-party basemap CDN — see #764), and the header + modal are
 * independent of it, so the flow is exercised regardless of whether it
 * paints under headless chromium.
 *
 * All selectors use existing id attributes — no data-testid additions.
 */
import { test, expect } from './fixtures';
import { safeGoto } from './e2e-utils';

test.describe('Exchange — create offer', () => {
    test('the Offer button opens the create modal without navigating away', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/exchange`);
        await authedPage.reload({ waitUntil: 'domcontentloaded' });

        const offerBtn = authedPage.locator('#new-offer-btn').first();
        await offerBtn.waitFor({ state: 'visible', timeout: 30_000 });
        const urlBefore = authedPage.url();
        await offerBtn.click();

        // Modal opened — its commodity field is present, and we didn't navigate.
        await expect(authedPage.locator('#exchange-commodity').first()).toBeVisible({ timeout: 30_000 });
        expect(authedPage.url()).toBe(urlBefore);
    });

    test('submitting creates a listing (POST /exchange/listings)', async ({
        authedPage,
        isolatedTenant,
    }) => {
        await safeGoto(authedPage, `/t/${isolatedTenant.tenantSlug}/exchange`);
        await authedPage.reload({ waitUntil: 'domcontentloaded' });

        await authedPage.locator('#new-offer-btn').first().click();
        await expect(authedPage.locator('#exchange-commodity').first()).toBeVisible({ timeout: 30_000 });

        // Commodity — open the combobox and pick a seeded option.
        await authedPage.locator('#exchange-commodity').first().click();
        await authedPage.getByRole('option', { name: 'Wheat' }).first().click();

        // Quantity.
        await authedPage.fill('#exchange-qty', '250');

        // Region — open the combobox and pick the first option.
        await authedPage.locator('#exchange-region').first().click();
        await authedPage.getByRole('option').first().click();

        // Submit and wait for the create POST to succeed.
        const [response] = await Promise.all([
            authedPage.waitForResponse((r) =>
                r.url().includes('/api/t/') &&
                r.url().endsWith('/exchange/listings') &&
                r.request().method() === 'POST',
            ),
            authedPage.getByRole('button', { name: 'Create offer' }).click(),
        ]);
        expect(response.status(), 'POST /exchange/listings succeeded').toBeLessThan(400);
    });
});
