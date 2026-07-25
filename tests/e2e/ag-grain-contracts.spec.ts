/**
 * Tier-1 ag workflow — grain marketing contract + fulfilment.
 *
 * Regression-proofs the financial contracting surface end to end:
 *   - a SALE contract is created with volume/price and is retrievable +
 *     correctly filtered by type (SALE vs PURCHASE) and by a MULTI-value
 *     status facet (the comma-joined wire shape the toolbar sends);
 *   - the list carries the derived contract VALUE and per-currency book
 *     totals (volume × price, never blended across currencies);
 *   - DELIVERED is gated on real movement: the transition is refused
 *     until a delivery is recorded, then accepted;
 *   - the fulfilment position (delivered / remaining) reflects the
 *     delivery ledger.
 *
 * Encrypted free-text (terms/pricingNotes) is out of scope here —
 * covered by the encryption manifest tests.
 *
 * GRAIN module (on by default). Synchronous path. Seeds via the API.
 */
import { test, expect } from './fixtures';

interface ListResponse {
    rows: Array<{ id: string; valueAmount: string | null; fulfilment?: { deliveredTonnes: string; remainingTonnes: string | null; progressPct: number | null } }>;
    totals: Array<{ currency: string | null; contractValue: string }>;
}

test('grain contract: create, filter, value, and deliver against it', async ({ authedPage, isolatedTenant }) => {
    const slug = isolatedTenant.tenantSlug;
    const api = authedPage.request;

    const res = await api.post(`/api/t/${slug}/grain/contracts`, {
        data: {
            counterparty: 'AgriBuyer Ltd',
            commodity: 'Wheat',
            type: 'SALE',
            status: 'ACTIVE',
            volumeTonnes: 500,
            pricePerTonne: 210,
            priceCurrency: 'GBP',
        },
    });
    expect(res.status(), `create contract: ${await res.text()}`).toBe(201);
    const contract = await res.json();
    expect(contract.counterparty).toBe('AgriBuyer Ltd');

    // ── type filter: present under SALE, absent under PURCHASE ──
    const sale: ListResponse = await (
        await api.get(`/api/t/${slug}/grain/contracts?type=SALE`)
    ).json();
    expect(sale.rows.some((c) => c.id === contract.id)).toBe(true);
    const purchase: ListResponse = await (
        await api.get(`/api/t/${slug}/grain/contracts?type=PURCHASE`)
    ).json();
    expect(purchase.rows.some((c) => c.id === contract.id)).toBe(false);

    // ── multi-select status facet: the comma-joined wire shape ──
    // Two selected statuses used to 500 (the raw string was cast into a
    // Prisma enum); it must now filter cleanly.
    const multi = await api.get(`/api/t/${slug}/grain/contracts?status=DRAFT,ACTIVE`);
    expect(multi.status(), `multi-status filter: ${await multi.text()}`).toBe(200);
    expect(((await multi.json()) as ListResponse).rows.some((c) => c.id === contract.id)).toBe(true);
    // An invalid member is a clean 400, never a 500.
    expect((await api.get(`/api/t/${slug}/grain/contracts?status=BOGUS`)).status()).toBe(400);

    // ── value: 500 t × 210 = 105000 GBP, exactly ──
    const row = sale.rows.find((c) => c.id === contract.id)!;
    expect(row.valueAmount).toBe('105000');
    const gbp = sale.totals.find((t) => t.currency === 'GBP');
    expect(gbp?.contractValue).toBe('105000');

    // ── DELIVERED is gated on real movement ──
    const premature = await api.patch(`/api/t/${slug}/grain/contracts/${contract.id}`, {
        data: { status: 'DELIVERED' },
    });
    expect(
        premature.status(),
        'DELIVERED must be refused before any delivery is recorded',
    ).toBe(400);

    const delivery = await api.post(
        `/api/t/${slug}/grain/contracts/${contract.id}/deliveries`,
        {
            data: {
                contractId: contract.id,
                tonnes: 300,
                deliveredAt: new Date().toISOString(),
                reference: 'WB-001',
            },
        },
    );
    expect(delivery.status(), `record delivery: ${await delivery.text()}`).toBe(201);

    // Fulfilment now reflects the ledger: 300 of 500, 200 remaining.
    const ledger = await (
        await api.get(`/api/t/${slug}/grain/contracts/${contract.id}/deliveries`)
    ).json();
    expect(ledger.fulfilment.deliveredTonnes).toBe('300');
    expect(ledger.fulfilment.remainingTonnes).toBe('200');
    expect(ledger.fulfilment.progressPct).toBe(60);

    // …and the transition is now accepted.
    const accepted = await api.patch(`/api/t/${slug}/grain/contracts/${contract.id}`, {
        data: { status: 'DELIVERED' },
    });
    expect(accepted.status(), `DELIVERED after movement: ${await accepted.text()}`).toBe(200);

    // ── UI: the contracts page lists the counterparty ──
    await authedPage.goto(`/t/${slug}/grain/contracts`);
    await expect(authedPage.getByText('AgriBuyer Ltd').first()).toBeVisible();
});
