/**
 * The insurance premium calculator, end to end on a phone (#1122). @mobile
 *
 * Tagged `@mobile` so it runs on the real phone profiles — `mobile-iphone` is an
 * iPhone 13 at 390x844 with touch and a coarse pointer — rather than calling
 * `setViewportSize` on a desktop UA. `.tap()` needs `hasTouch`, so running it on
 * the desktop project would fail; the tag is what keeps it off there, via that
 * project's `grepInvert: /@mobile/`.
 *
 * `npx playwright test tests/e2e/insurance-quote.spec.ts` runs it TWICE, once
 * per phone project — verified with `--list`, not inferred from the config.
 *
 * What this covers that no rendered test can: the real POST, the server's own
 * recomputation, and that "Request sent" survives a RELOAD — the whole reason
 * `listInquiredParcelIds` exists, since the optimistic flag dies on unmount.
 *
 * MUTATING, so it takes `isolatedTenant`: it writes a location, a parcel and a
 * lead, and sending a lead also enqueues the operator email.
 *
 * Hermetic, like the rest of the suite — it adds no external request. The
 * calculator deliberately needs no satellite reading, which is also why the
 * parcel card renders here with no Sentinel data configured in CI.
 */
import { test, expect } from './fixtures';
import { agPrisma, square } from './ag-fixtures';

/** €100,000 of cover on 1,000 dca of wheat at the 10 % tariff. */
const SUM_INSURED = '100 000';
const EXPECTED_PREMIUM = '€10,000.00';
const EXPECTED_PER_DCA = '€10.00';
const EXPECTED_SCHEDULE = ['€3,333.34', '€3,333.33', '€3,333.33'];

test('the calculator prices a parcel and the request survives a reload @mobile', async ({
    authedPage: page,
    isolatedTenant,
}) => {
    const slug = isolatedTenant.tenantSlug;
    const api = page.request;
    const prisma = agPrisma();

    try {
        // ── Seed through the real routes ─────────────────────────────────
        const field = await (
            await api.post(`/api/t/${slug}/locations`, { data: { name: 'Polje Sever' } })
        ).json();

        const parcelRes = await api.post(`/api/t/${slug}/locations/${field.id}/parcels`, {
            // Free text, exactly as the importers write it — the product
            // preselect has to normalise it rather than match exactly.
            data: { name: 'North Block', cropType: 'Winter Wheat', geometry: square(25.1, 43.1) },
        });
        expect(parcelRes.status(), `create parcel: ${await parcelRes.text()}`).toBe(201);
        const parcel = await parcelRes.json();

        // `areaHa` is a DENORMALISED column the create fills from ST_Area, and
        // no route accepts it — so pin it here to get an exact 100 ha (1,000
        // dca). Without a known area the per-dca figure below is unassertable.
        await prisma.parcel.update({ where: { id: parcel.id }, data: { areaHa: 100 } });

        // ── Farm risk, on a phone ────────────────────────────────────────
        await page.goto(`/t/${slug}/farm-risk`);
        // One location, so it is selected on load — no picker to drive.
        const main = page.getByRole('main');
        await expect(main.getByText('North Block')).toBeVisible();

        // The button renders with NO satellite reading: it sits outside the
        // `risk ? … : unavailable` branch precisely so a cloudy week cannot
        // cost a farmer a quote.
        const trigger = main.getByRole('button', { name: 'Request insurance quote' });
        await expect(trigger).toBeVisible();

        // ── Step 1: product ─────────────────────────────────────────────
        await trigger.tap();
        const dialog = page.getByRole('dialog');
        // ONE tap reaches step 1 — no message box, no confirmation between.
        await expect(dialog.getByText('What do you want to insure?')).toBeVisible();
        // "Winter Wheat" normalises to the wheat product.
        await expect(dialog.locator('#insurance-quote-product-wheat')).toHaveAttribute(
            'data-state',
            'checked',
        );

        // ── Step 2: cover ───────────────────────────────────────────────
        await dialog.getByTestId('wizard-next').tap();
        await expect(dialog.getByText('Cover')).toBeVisible();
        // 100 ha prefilled as DECARES. Hectares are converted and never shown.
        await expect(dialog.locator('#insurance-quote-area')).toHaveValue('1000');

        await dialog.locator('#insurance-quote-sum').fill(SUM_INSURED);
        // The live premium, with no Calculate button in between.
        await expect(dialog.locator('#insurance-quote-premium')).toContainText(EXPECTED_PREMIUM);
        await expect(dialog.locator('#insurance-quote-premium')).toContainText(EXPECTED_PER_DCA);

        // ── Step 3: schedule and send ───────────────────────────────────
        await dialog.getByTestId('wizard-next').tap();
        await expect(dialog.getByText('Payment')).toBeVisible();
        await expect(dialog.locator('#insurance-quote-premium')).toContainText(EXPECTED_PREMIUM);

        await dialog.locator('#insurance-quote-instalments-3').tap();
        for (const amount of EXPECTED_SCHEDULE) {
            // The remainder lands on the FIRST instalment, so the three parts
            // sum back to €10,000.00 exactly.
            await expect(dialog.getByText(amount, { exact: true }).first()).toBeVisible();
        }

        await dialog.getByTestId('wizard-finish').tap();

        // The toast is the confirmation; the drawer closing is also what Cancel
        // does, so closing alone would not prove the send.
        await expect(
            page.getByText('Quote request sent. You will find it in your notifications.'),
        ).toBeVisible();
        await expect(main.getByText('Request sent')).toBeVisible();

        // ── The durable half ────────────────────────────────────────────
        await page.reload();
        // A brand-new component instance, so the optimistic flag is gone. Only
        // the server read can carry this.
        await expect(page.getByRole('main').getByText('Request sent')).toBeVisible();

        // …and the lead really is one row with the SERVER's figure, not the
        // client's.
        const leads = await prisma.insuranceLead.findMany({
            where: { inquirerTenantId: isolatedTenant.tenantId, parcelId: parcel.id },
        });
        expect(leads).toHaveLength(1);
        const quote = leads[0].quoteJson as Record<string, unknown> | null;
        expect(quote).not.toBeNull();
        expect(quote!.premiumCents).toBe(1_000_000);
        expect(quote!.tariffBp).toBe(1000);
        expect(quote!.instalmentsCents).toEqual([333_334, 333_333, 333_333]);
        expect(quote!.areaScope).toBe('parcel');
    } finally {
        await prisma.$disconnect();
    }
});
