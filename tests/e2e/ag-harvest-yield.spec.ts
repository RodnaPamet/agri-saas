/**
 * Tier-1 ag workflow — harvest yield record.
 *
 * Regression-proofs the financial production figure: a yield record's
 * t/ha is computed server-side from grossTonnes ÷ areaHa (never the
 * client), and the record surfaces in the season/field rollup list. A
 * regression here mis-states realised production + downstream valuations.
 *
 * GRAIN module (on by default). Synchronous path. Seeds via ag-fixtures.
 */
import { test, expect } from './fixtures';
import { createField } from './ag-fixtures';

test('harvest yield: a record computes t/ha from gross tonnes and area', async ({ authedPage, isolatedTenant }) => {
    const slug = isolatedTenant.tenantSlug;
    const api = authedPage.request;

    const locationId = await createField(api, slug, 'North Farm');

    const res = await api.post(`/api/t/${slug}/grain/yield-records`, {
        data: {
            locationId,
            commodity: 'Winter Wheat',
            grossTonnes: 90,
            areaHa: 10,
            moisturePct: 14,
            harvestedAt: '2026-09-01',
        },
    });
    expect(res.status(), `create yield: ${await res.text()}`).toBe(201);
    const rec = await res.json();
    // 90 t at 14% moisture is already ON the standard basis, so the adjusted
    // tonnage equals the gross one and t/ha is 90 / 10 either way.
    expect(rec.netTonnesStd).toBeCloseTo(90, 3);
    expect(rec.tPerHa).toBeCloseTo(9, 3);
    expect(rec.tPerHaBasis).toBe('standard-moisture');

    // It appears in the list. The list read returns a paged envelope
    // ({ rows, totalCount, truncated }) so the 500-row cap can be reported
    // rather than silently truncating.
    const list = await (await api.get(`/api/t/${slug}/grain/yield-records`)).json();
    expect(Array.isArray(list.rows)).toBe(true);
    expect(list.rows.some((r: { id: string }) => r.id === rec.id)).toBe(true);
    // Commercial valuation commentary is NOT broadcast in list rows.
    const listed = list.rows.find((r: { id: string }) => r.id === rec.id);
    expect(listed).not.toHaveProperty('valuationNotes');

    // Two selected seasons/fields must filter, not return an empty table.
    const filtered = await (
        await api.get(`/api/t/${slug}/grain/yield-records?locationId=${locationId},${locationId}`)
    ).json();
    expect(filtered.rows.some((r: { id: string }) => r.id === rec.id)).toBe(true);

    // UI: the yield page renders the harvest.
    await authedPage.goto(`/t/${slug}/grain/yield`);
    await expect(authedPage.getByText('Winter Wheat').first()).toBeVisible();
});
