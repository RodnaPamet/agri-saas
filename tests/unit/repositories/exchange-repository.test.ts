/**
 * Coverage wave 22 — `ExchangeRepository`.
 *
 * 9 uncovered functions at 10%. This is the one repository in the
 * codebase whose reads are DELIBERATELY global: `ExchangeListing` /
 * `ExchangeInquiry` have no `tenantId` column at all, because the
 * marketplace only works if tenants can see each other's offers. Write
 * safety lives one layer up in `usecases/exchange.ts`.
 *
 * That inversion is why these tests matter. The usual repository
 * heuristic — "assert the tenant filter" — is actively WRONG here, so the
 * invariants worth pinning are different ones:
 *
 *   - the browse query hides expired-but-still-ACTIVE rows;
 *   - the seller inbox reaches the tenant through `listing.sellerTenantId`
 *     while the buyer outbox uses the inquiry's own `inquirerTenantId` —
 *     swapping those two shows each party the other's view;
 *   - every list is bounded (query-shape guardrail D2 has no `tenantId`
 *     to lean on here, so the cap is the only thing between a browse and
 *     the whole table);
 *   - `declinePendingInquiries` reads the ids BEFORE the updateMany,
 *     because a count cannot be notified.
 */
import { ExchangeRepository } from '@/app-layer/repositories/exchange';
import type { PrismaTx } from '@/lib/db-context';

function makeDb() {
    const model = () => ({
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'created' }),
        update: jest.fn().mockResolvedValue({ id: 'updated' }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    });
    return { exchangeListing: model(), exchangeInquiry: model() };
}

type FakeDb = ReturnType<typeof makeDb>;
const asTx = (db: FakeDb) => db as unknown as PrismaTx;

const argOf = (fn: jest.Mock) => fn.mock.calls[0][0];
const whereOf = (fn: jest.Mock) => fn.mock.calls[0][0].where;

let db: FakeDb;
beforeEach(() => {
    db = makeDb();
});

describe('ExchangeRepository.listActiveListings', () => {
    it('shows ACTIVE rows that are either open-ended or not yet expired', async () => {
        // Break: dropping the expiry OR. An ACTIVE row past its expiry
        // stays visible until the sweep job runs, so buyers would enquire
        // about grain that is no longer for sale.
        await ExchangeRepository.listActiveListings(asTx(db));

        const where = whereOf(db.exchangeListing.findMany);
        expect(where.status).toBe('ACTIVE');
        expect(where.OR[0]).toEqual({ expiresAt: null });
        expect(where.OR[1].expiresAt.gt).toBeInstanceOf(Date);
    });

    it('bounds the browse', async () => {
        // Break: removing `take`. There is no tenant filter on this table
        // — the cap is the ONLY bound on a public marketplace browse, and
        // its absence is a trivially reachable memory exhaustion.
        await ExchangeRepository.listActiveListings(asTx(db));

        expect(argOf(db.exchangeListing.findMany).take).toBe(100);
        expect(argOf(db.exchangeListing.findMany).orderBy).toEqual({ createdAt: 'desc' });
    });

    it('adds no facet keys when no filters are supplied', async () => {
        await ExchangeRepository.listActiveListings(asTx(db));

        expect(Object.keys(whereOf(db.exchangeListing.findMany)).sort()).toEqual(['OR', 'status']);
    });

    it('matches commodity case-insensitively but region code exactly', async () => {
        // Break: harmonising the two. Commodity is free text a farmer
        // typed ("Wheat" / "wheat"); regionCode is a controlled NUTS-style
        // code where a substring match would make BG31 match BG3.
        await ExchangeRepository.listActiveListings(asTx(db), {
            commodity: 'wheat',
            regionCode: 'BG31',
        });

        expect(whereOf(db.exchangeListing.findMany)).toMatchObject({
            commodity: { contains: 'wheat', mode: 'insensitive' },
            regionCode: 'BG31',
        });
    });

    it('applies the side and kind facets verbatim', async () => {
        await ExchangeRepository.listActiveListings(asTx(db), { side: 'SELL', kind: 'CULTURE' });

        expect(whereOf(db.exchangeListing.findMany)).toMatchObject({ side: 'SELL', kind: 'CULTURE' });
    });

    it('builds a two-sided tonnage range when both bounds are given', async () => {
        await ExchangeRepository.listActiveListings(asTx(db), { minTonnes: 10, maxTonnes: 50 });

        expect(whereOf(db.exchangeListing.findMany).quantityTonnes).toEqual({ gte: 10, lte: 50 });
    });

    it('builds a one-sided range from a single bound', async () => {
        await ExchangeRepository.listActiveListings(asTx(db), { minTonnes: 10 });

        expect(whereOf(db.exchangeListing.findMany).quantityTonnes).toEqual({ gte: 10 });
    });

    it('builds a max-only range too', async () => {
        // The two bounds are built by independent spreads; covering only
        // the `gte` side would leave a broken `lte` spread undetected.
        await ExchangeRepository.listActiveListings(asTx(db), { maxTonnes: 50 });

        expect(whereOf(db.exchangeListing.findMany).quantityTonnes).toEqual({ lte: 50 });
    });

    it('treats a zero-tonne bound as a real filter, not as absent', async () => {
        // Break: `if (filters.minTonnes)` instead of `!= null`. Zero is
        // falsy, so "at most 5 t" (min unset, max 5) is fine — but a
        // `minTonnes: 0` from a cleared slider would silently drop the
        // whole range clause. The `!= null` form is what makes 0 mean 0.
        await ExchangeRepository.listActiveListings(asTx(db), { minTonnes: 0, maxTonnes: 5 });

        expect(whereOf(db.exchangeListing.findMany).quantityTonnes).toEqual({ gte: 0, lte: 5 });
    });

    it('adds no tonnage clause when neither bound is given', async () => {
        await ExchangeRepository.listActiveListings(asTx(db), { side: 'BUY' });

        expect(whereOf(db.exchangeListing.findMany)).not.toHaveProperty('quantityTonnes');
    });
});

describe('ExchangeRepository — single-row reads and writes', () => {
    it('reads a listing globally, by id alone', async () => {
        // Pinned on purpose: the absence of a tenant filter is the design
        // (see the module header). A future "fix" that adds one breaks
        // every buyer's ability to open a listing they do not own.
        await ExchangeRepository.getListing(asTx(db), 'l-1');

        expect(argOf(db.exchangeListing.findUnique)).toEqual({ where: { id: 'l-1' } });
    });

    it('passes the listing payload through untouched', async () => {
        // Ownership fields are set by the usecase from the request
        // context; the repository must not second-guess them.
        const data = { sellerTenantId: 'tenant-1', sellerUserId: 'user-1', commodity: 'wheat' };

        await ExchangeRepository.createListing(asTx(db), data as never);

        expect(argOf(db.exchangeListing.create)).toEqual({ data });
    });

    it('flips only the status when a listing reaches a terminal state', async () => {
        await ExchangeRepository.updateListingStatus(asTx(db), 'l-1', 'WITHDRAWN' as never);

        expect(argOf(db.exchangeListing.update)).toEqual({
            where: { id: 'l-1' },
            data: { status: 'WITHDRAWN' },
        });
    });

    it('passes the inquiry payload through untouched', async () => {
        const data = { listingId: 'l-1', inquirerTenantId: 'tenant-2' };

        await ExchangeRepository.createInquiry(asTx(db), data as never);

        expect(argOf(db.exchangeInquiry.create)).toEqual({ data });
    });

    it('loads an inquiry together with its listing, for the ownership guard', async () => {
        // Break: dropping the `include`. `usecases/exchange.ts` compares
        // `ctx.tenantId` against `inquiry.listing.sellerTenantId` to decide
        // who may accept — without the relation that check reads
        // `undefined` and the comparison silently fails open or closed.
        await ExchangeRepository.getInquiry(asTx(db), 'i-1');

        expect(argOf(db.exchangeInquiry.findUnique)).toEqual({
            where: { id: 'i-1' },
            include: { listing: true },
        });
    });

    it('writes the status and the consent stamp in one update', async () => {
        // Break: splitting these into two writes. Between them an inquiry
        // is ACCEPTED with no shared contact, so a buyer sees an accepted
        // deal and no way to reach anyone. The DB CHECK constraint refuses
        // the inverse pair, so this single write is the only safe shape.
        const at = new Date('2026-05-01T09:00:00.000Z');

        await ExchangeRepository.updateInquiryStatus(asTx(db), 'i-1', 'ACCEPTED' as never, at);

        expect(argOf(db.exchangeInquiry.update)).toEqual({
            where: { id: 'i-1' },
            data: { status: 'ACCEPTED', contactSharedAt: at },
        });
    });

    it('declines without stamping a consent time', async () => {
        await ExchangeRepository.updateInquiryStatus(asTx(db), 'i-1', 'DECLINED' as never, null);

        expect(argOf(db.exchangeInquiry.update).data).toEqual({
            status: 'DECLINED',
            contactSharedAt: null,
        });
    });
});

describe('ExchangeRepository — the seller inbox and buyer outbox', () => {
    it('reaches the seller inbox through the listing’s owner', async () => {
        // Break: `where: { inquirerTenantId: sellerTenantId }`. The seller
        // would be shown the inquiries they SENT as a buyer instead of the
        // ones they received — and, worse, the swap is symmetric so both
        // views still render plausibly.
        await ExchangeRepository.listInquiriesForSeller(asTx(db), 'tenant-1');

        expect(whereOf(db.exchangeInquiry.findMany)).toEqual({
            listing: { sellerTenantId: 'tenant-1' },
        });
        expect(argOf(db.exchangeInquiry.findMany).take).toBe(100);
    });

    it('reads the buyer outbox off the inquiry’s own tenant column', async () => {
        await ExchangeRepository.listInquiriesByInquirer(asTx(db), 'tenant-2');

        expect(whereOf(db.exchangeInquiry.findMany)).toEqual({ inquirerTenantId: 'tenant-2' });
        expect(argOf(db.exchangeInquiry.findMany).take).toBe(100);
    });

    it('lists a seller’s own listings with their inquiries, both bounded', async () => {
        await ExchangeRepository.listListingsBySeller(asTx(db), 'tenant-1');

        const arg = argOf(db.exchangeListing.findMany);
        expect(arg.where).toEqual({ sellerTenantId: 'tenant-1' });
        expect(arg.take).toBe(100);
        expect(arg.include.inquiries.take).toBe(100);
    });
});

describe('ExchangeRepository.declinePendingInquiries', () => {
    it('returns who was declined, not just how many', async () => {
        // Break: returning the `updateMany` count. Every declined buyer is
        // supposed to be notified, and a count carries no recipients — the
        // notifications would silently stop while the status flip kept
        // working, so nothing would look broken.
        db.exchangeInquiry.findMany.mockResolvedValue([
            { id: 'i-1', inquirerTenantId: 'tenant-2' },
            { id: 'i-2', inquirerTenantId: 'tenant-3' },
        ]);

        const res = await ExchangeRepository.declinePendingInquiries(asTx(db), 'l-1');

        expect(res).toEqual([
            { id: 'i-1', inquirerTenantId: 'tenant-2' },
            { id: 'i-2', inquirerTenantId: 'tenant-3' },
        ]);
    });

    it('reads the pending ids first, then updates exactly those rows', async () => {
        // Break: reordering the two statements. After the updateMany there
        // are no PENDING rows left to read, so the notify list comes back
        // empty every time.
        db.exchangeInquiry.findMany.mockResolvedValue([{ id: 'i-1', inquirerTenantId: 'tenant-2' }]);

        await ExchangeRepository.declinePendingInquiries(asTx(db), 'l-1');

        expect(whereOf(db.exchangeInquiry.findMany)).toEqual({
            listingId: 'l-1',
            status: 'PENDING',
        });
        expect(argOf(db.exchangeInquiry.updateMany)).toEqual({
            where: { id: { in: ['i-1'] } },
            data: { status: 'DECLINED' },
        });
    });

    it('only ever touches PENDING inquiries on the named listing', async () => {
        // Break: dropping `status: PENDING` from the read. An already
        // ACCEPTED deal would be flipped to DECLINED when the seller
        // fulfils the listing — cancelling the very agreement that
        // completed it.
        db.exchangeInquiry.findMany.mockResolvedValue([{ id: 'i-1', inquirerTenantId: 'tenant-2' }]);

        await ExchangeRepository.declinePendingInquiries(asTx(db), 'l-1');

        expect(whereOf(db.exchangeInquiry.findMany).status).toBe('PENDING');
        expect(argOf(db.exchangeInquiry.findMany).take).toBe(200);
    });

    it('issues no write when nothing is pending', async () => {
        expect(await ExchangeRepository.declinePendingInquiries(asTx(db), 'l-1')).toEqual([]);
        expect(db.exchangeInquiry.updateMany).not.toHaveBeenCalled();
    });
});
