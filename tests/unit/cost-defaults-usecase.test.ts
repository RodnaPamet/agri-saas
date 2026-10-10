/**
 * «Последни стойности» returns the farm's OWN last overhead figures.
 *
 * Owner decision 2026-10-09: the defaults are the farm's own last values, and
 * explicitly "no Agrent-wide table". So the first case here is that an empty
 * farm gets an empty answer — a benchmark leaking in would be a product
 * decision reversed, not a bug.
 *
 * ## The per-crop half, which this file used to say was absent
 *
 * It said: "There is no per-crop half. `CostEntry` has no commodity column",
 * and that was true and well-reasoned — all four live cost entries on the
 * owner's farm carry no domain link at all, so
 * `CostEntry.parcelId → Parcel.cropType` resolved nothing and per-crop
 * defaults would have been a second always-empty surface. The note's own
 * conclusion was that the read must key on whatever crop field the new form
 * writes, rather than on a path chosen first.
 *
 * #1583 settled that: `commodityCanonical`, written only on a `CROP`-basis
 * row. `getCropCostDefaults` keys on that pair, and its cases are below.
 */
import {
    getCostDefaults,
    getCropCostDefaults,
    OVERHEAD_CATEGORIES,
} from '@/app-layer/usecases/cost-defaults';
import { makeRequestContext } from '../helpers/make-context';

const mockDb = {
    costEntry: { findMany: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));

const ctx = () => makeRequestContext('OWNER', { userId: 'u-1', tenantId: 't-1', tenantSlug: 't' });

/** A row as the select returns it. `incurredOn` descending is the caller's job. */
function row(over: Partial<Record<string, unknown>> = {}) {
    return {
        category: 'PAYROLL',
        amount: 36000,
        currency: 'BGN',
        incurredOn: new Date('2026-01-31'),
        payrollHeadcount: null,
        payrollAnnualPerPerson: null,
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.costEntry.findMany.mockResolvedValue([]);
});

describe('getCostDefaults', () => {
    it('an empty farm gets an EMPTY answer, not a benchmark', () => {
        // The owner's "no Agrent-wide table" made concrete. A seeded default
        // leaking in here would be a reversed product decision wearing the
        // clothes of a convenience.
        return expect(getCostDefaults(ctx())).resolves.toEqual({ overheads: [] });
    });

    it('returns the NEWEST row per category, relying on the query order', () => {
        // The rows arrive newest-first, so "first wins" is the whole of the
        // latest-per-category logic. If the order were lost, this returns the
        // older figure and a prefill quietly shows last year's salary.
        mockDb.costEntry.findMany.mockResolvedValue([
            row({ amount: 40000, incurredOn: new Date('2026-06-30') }),
            row({ amount: 36000, incurredOn: new Date('2026-01-31') }),
        ]);

        return expect(getCostDefaults(ctx())).resolves.toMatchObject({
            overheads: [{ category: 'PAYROLL', amount: 40000 }],
        });
    });

    it('orders the OUTPUT by category, not by date', () => {
        // So the form's fields do not swap places between visits. Asserted on
        // the declared order rather than on the input order, which is the thing
        // that would otherwise leak through.
        mockDb.costEntry.findMany.mockResolvedValue([
            row({ category: 'OTHER', amount: 1, incurredOn: new Date('2026-12-01') }),
            row({ category: 'PAYROLL', amount: 2, incurredOn: new Date('2026-11-01') }),
            row({ category: 'DEPRECIATION', amount: 3, incurredOn: new Date('2026-10-01') }),
        ]);

        return expect(getCostDefaults(ctx())).resolves.toMatchObject({
            overheads: [
                { category: 'PAYROLL' },
                { category: 'DEPRECIATION' },
                { category: 'OTHER' },
            ],
        });
    });

    it('carries the payroll breakdown, and null is NOT zero', async () => {
        // The distinction a prefill depends on. `null` says the farmer entered
        // a plain total; `0` would say nobody earns anything. Writing zeros
        // over that would overwrite real figures with a number nobody typed.
        mockDb.costEntry.findMany.mockResolvedValue([
            row({ payrollHeadcount: 3, payrollAnnualPerPerson: 12000 }),
            row({ category: 'OTHER' }),
        ]);

        const r = await getCostDefaults(ctx());

        expect(r.overheads[0]).toMatchObject({
            category: 'PAYROLL',
            payrollHeadcount: 3,
            payrollAnnualPerPerson: 12000,
        });
        expect(r.overheads[1]).toMatchObject({
            category: 'OTHER',
            payrollHeadcount: null,
            payrollAnnualPerPerson: null,
        });
    });

    it('asks only for the OVERHEAD categories', async () => {
        await getCostDefaults(ctx());
        const where = mockDb.costEntry.findMany.mock.calls[0][0].where;

        expect(where.category.in.sort()).toEqual([...OVERHEAD_CATEGORIES].sort());
        // RENT is a per-decare crop line in the owner's split, not an overhead.
        expect(where.category.in).not.toContain('RENT');
    });

    it('does NOT filter by allocationBasis', async () => {
        // Filtering on HOLDING would look right — an overhead spreads that way
        // — and would return nothing: the four live entries on the owner's farm
        // are all TARGET. A default answers "what did I last type", which is
        // about the figure rather than how it was spread.
        await getCostDefaults(ctx());
        const where = mockDb.costEntry.findMany.mock.calls[0][0].where;

        expect(where.allocationBasis).toBeUndefined();
    });

    it('scopes to the tenant and excludes soft-deleted rows', async () => {
        await getCostDefaults(ctx());
        const where = mockDb.costEntry.findMany.mock.calls[0][0].where;

        expect(where.tenantId).toBe('t-1');
        expect(where.deletedAt).toBeNull();
    });

    it('orders newest-first with an id tie-break', async () => {
        // `incurredOn` is a DATE, so a day with several salary entries has no
        // total order without `id` — and "the latest" would differ between
        // reads. Same reasoning `listPage` states for its own ordering.
        await getCostDefaults(ctx());
        const orderBy = mockDb.costEntry.findMany.mock.calls[0][0].orderBy;

        expect(orderBy).toEqual([{ incurredOn: 'desc' }, { id: 'desc' }]);
    });

    it('bounds the read', async () => {
        // The bound only has to be big enough that every category's newest row
        // is inside it; unbounded would be a table scan on a screen that opens
        // on a tap.
        await getCostDefaults(ctx());

        expect(mockDb.costEntry.findMany.mock.calls[0][0].take).toBeGreaterThan(0);
    });
});

describe('getCropCostDefaults — the «Култура» sheet prefill', () => {
    const line = (over: Record<string, unknown> = {}) => ({
        category: 'FERTILIZER',
        amountPerDca: 12.5,
        currency: 'EUR',
        incurredOn: new Date('2026-03-01T09:00:00.000Z'),
        description: 'торове',
        ...over,
    });

    beforeEach(() => mockDb.costEntry.findMany.mockReset());

    it('returns the latest SET, not just the latest row', async () => {
        // A sheet is several lines entered together. Prefilling only the newest
        // would collapse ПРЗ + торове + seed into one line, and the farmer
        // would re-type the rest without noticing they had been dropped.
        mockDb.costEntry.findMany.mockResolvedValue([
            line({ description: 'торове' }),
            line({ description: 'ПРЗ', category: 'PESTICIDE' }),
            // An OLDER sheet — same crop, different day. Must not come back.
            line({ description: 'старо', incurredOn: new Date('2025-03-01T09:00:00.000Z') }),
        ]);

        const r = await getCropCostDefaults(ctx(), 'Wheat');

        expect(r.lines.map((l) => l.description)).toEqual(['торове', 'ПРЗ']);
    });

    it('normalises the spelling and echoes the CANONICAL commodity', async () => {
        // `Canola` resolves to `rapeseed` — a rename, not a case fold. The echo
        // is how a client knows what the server actually looked up.
        mockDb.costEntry.findMany.mockResolvedValue([]);

        const r = await getCropCostDefaults(ctx(), 'Canola');

        expect(r.commodity).toBe('rapeseed');
        expect(mockDb.costEntry.findMany.mock.calls[0][0].where.commodityCanonical).toBe('rapeseed');
    });

    it('REFUSES a commodity that does not resolve', async () => {
        // Not an empty sheet: an empty answer is indistinguishable from "this
        // crop has no history", so a typo would read as a fact about the farm.
        await expect(getCropCostDefaults(ctx(), 'lavender')).rejects.toThrow();
        expect(mockDb.costEntry.findMany).not.toHaveBeenCalled();
    });

    it('keys on CROP basis AND the commodity, and excludes soft-deleted', async () => {
        mockDb.costEntry.findMany.mockResolvedValue([]);

        await getCropCostDefaults(ctx(), 'Wheat');

        const where = mockDb.costEntry.findMany.mock.calls[0][0].where;
        expect(where.allocationBasis).toBe('CROP');
        expect(where.commodityCanonical).toBe('wheat');
        expect(where.deletedAt).toBeNull();
    });

    it('no history means an EMPTY sheet, not an error', async () => {
        mockDb.costEntry.findMany.mockResolvedValue([]);

        const r = await getCropCostDefaults(ctx(), 'Wheat');

        expect(r).toEqual({ commodity: 'wheat', lines: [] });
    });

    it('keeps a line whose rate is NULL rather than dropping it', async () => {
        // Null means the farmer entered a total. Dropping the line would hide
        // that the farm has such a cost at all; null lets the client show the
        // row unfilled.
        mockDb.costEntry.findMany.mockResolvedValue([line({ amountPerDca: null })]);

        const r = await getCropCostDefaults(ctx(), 'Wheat');

        expect(r.lines).toHaveLength(1);
        expect(r.lines[0].amountPerDca).toBeNull();
    });

    it('carries each line\'s OWN currency', async () => {
        // Bulgaria moved to EUR in 2026 and older rows are in BGN. A client
        // prefilling the number without reading the currency shows a 24 000 лв
        // salary as €24 000 — wrong by 1.95583, and perfectly plausible.
        mockDb.costEntry.findMany.mockResolvedValue([
            line({ currency: 'BGN', description: 'старо' }),
            line({ currency: 'EUR', description: 'ново' }),
        ]);

        const r = await getCropCostDefaults(ctx(), 'Wheat');

        expect(r.lines.map((l) => l.currency)).toEqual(['BGN', 'EUR']);
    });
});
