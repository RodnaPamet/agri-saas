/**
 * Exchange — two-sided inquiry flow (PR2).
 *
 * The create spec is single-sided. This exercises the whole handshake across
 * TWO isolated tenants: tenant A posts a listing, tenant B (a second signed-in
 * context) browses it, opens the detail Sheet, expresses interest, and A then
 * sees the inquiry in "My listings" and accepts it.
 *
 * Accept is the point the deal completes: A supplies a per-listing contact,
 * B supplies theirs with the inquiry, and neither is visible to the other
 * until A accepts. The last two assertions are the whole feature end-to-end —
 * B's contact was withheld from A's own management page while the inquiry was
 * PENDING, and appears on it the moment A accepts.
 *
 * Setup uses the authenticated API for A's listing (robust); the cross-tenant
 * inquiry + the seller's accept go through the real UI (the behaviour under
 * test). Selectors use existing ids/roles — no data-testid. The InquiryModal
 * and the detail Sheet are BOTH dialogs, so the modal is disambiguated by its
 * "Express interest — …" title. Single self-contained test (no cross-test let).
 */
import { test, expect } from './fixtures';
import { createIsolatedTenant, signInAs, safeGoto } from './e2e-utils';

test.describe('Exchange — two-sided inquiry', () => {
    test('A posts → B inquires via the detail Sheet → A accepts', async ({
        browser,
        authedPage,
        isolatedTenant,
        request,
    }) => {
        const slugA = isolatedTenant.tenantSlug;
        // The commodity can no longer be a unique free-text string: it is
        // constrained to the canonical vocabulary, so `Wheat-${Date.now()}` is
        // now a 400. The row is disambiguated by a unique QUANTITY instead —
        // still one-of-a-kind in the shared cross-tenant feed, and it does not
        // depend on inventing a commodity nobody trades.
        const commodity = 'wheat';
        const uniqueTonnes = String(200 + (Date.now() % 8000));
        // Unique contacts so an assertion cannot pass on seed data.
        const sellerContact = `+359 88 ${Date.now() % 1_000_000}`;
        const buyerContact = `buyer-${Date.now()}@farm.test`;

        // ── A (seller) posts a listing via the authenticated API ──────────
        const createRes = await authedPage.request.post(
            `/api/t/${slugA}/exchange/listings`,
            {
                data: {
                    side: 'SELL', kind: 'CULTURE', commodity,
                    quantityTonnes: uniqueTonnes, regionCode: 'BG-16',
                    sellerContact,
                },
            },
        );
        expect(createRes.ok(), 'A creates a listing').toBeTruthy();
        // The listing projection must NEVER carry the private contact, however
        // it was fetched — this is the projection's privacy contract, asserted
        // against the real wire shape rather than the unit-test fixture.
        expect(JSON.stringify(await createRes.json())).not.toContain(sellerContact);

        // ── B (buyer) — a second isolated tenant + fresh signed-in context ─
        const tenantB = await createIsolatedTenant({ request, namePrefix: 'exchange-two-sided-B' });
        const ctxB = await browser.newContext();
        const pageB = await ctxB.newPage();
        try {
            await signInAs(pageB, tenantB);
            await safeGoto(pageB, `/t/${tenantB.tenantSlug}/exchange`);
            await pageB.reload({ waitUntil: 'domcontentloaded' });

            // A's listing is visible cross-tenant — open its detail Sheet.
            const row = pageB
                .getByRole('main')
                .getByRole('button', { name: new RegExp(uniqueTonnes) });
            await row.first().waitFor({ state: 'visible', timeout: 30_000 });
            await row.first().click();

            // Sheet → "Express interest" opens the inquiry modal (only one such
            // button exists until the modal mounts).
            await pageB.getByRole('button', { name: /express interest/i }).click();

            const modal = pageB.getByRole('dialog', { name: /express interest/i });
            await modal.getByPlaceholder(/introduce yourself/i).fill('Interested — can you do 100t?');
            // B consents to sharing a contact IF A accepts.
            await modal.getByLabel(/your contact/i).fill(buyerContact);

            const [inqRes] = await Promise.all([
                pageB.waitForResponse((r) =>
                    r.url().includes('/exchange/inquiries') && r.request().method() === 'POST',
                ),
                modal.getByRole('button', { name: /express interest/i }).click(),
            ]);
            expect(inqRes.status(), 'B submits the inquiry').toBeLessThan(400);
        } finally {
            await ctxB.close();
        }

        // ── A sees the inquiry in "My listings" and accepts it ────────────
        await safeGoto(authedPage, `/t/${slugA}/exchange/my-listings`);
        await authedPage.reload({ waitUntil: 'domcontentloaded' });
        const mainA = authedPage.getByRole('main');
        await expect(mainA.getByText('Interested — can you do 100t?')).toBeVisible({ timeout: 30_000 });

        // PENDING: B's contact exists on the row, and A cannot see it.
        await expect(mainA.getByText(buyerContact)).toHaveCount(0);

        const [respRes] = await Promise.all([
            authedPage.waitForResponse((r) =>
                r.url().includes('/exchange/inquiries/') && r.request().method() === 'PATCH',
            ),
            mainA.getByRole('button', { name: /^Accept$/ }).first().click(),
        ]);
        expect(respRes.status(), 'A accepts the inquiry').toBeLessThan(400);
        await expect(mainA.getByText('Accepted').first()).toBeVisible({ timeout: 15_000 });
        // …and the accept completes the deal: B's contact is now on A's page.
        await expect(mainA.getByText(buyerContact)).toBeVisible({ timeout: 15_000 });
    });
});
