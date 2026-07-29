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
 *   - the browse query hides expired-but-still-ACTIVE rows, and keeps that
 *     clause under `AND` where a second disjunction cannot displace it;
 *   - the seller's view reaches the tenant through the LISTING's
 *     `sellerTenantId` while the buyer outbox uses the INQUIRY's own
 *     `inquirerTenantId` — swapping those two shows each party the other's
 *     view;
 *   - every list is bounded (query-shape guardrail D2 has no `tenantId`
 *     to lean on here, so the cap is the only thing between a browse and
 *     the whole table);
 *   - facets select exactly the values chosen, and only the free-text
 *     search is fuzzy — and even it never substring-matches a region CODE;
 *   - `declinePendingInquiries` reads the ids BEFORE the updateMany,
 *     because a count cannot be notified.
 */
import {
    ExchangeRepository,
    LISTING_PAGE_SIZE,
    LISTING_PAGE_MAX,
} from '@/app-layer/repositories/exchange';
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

/**
 * The browse `where` carries its predicates in an `AND` list rather than on
 * the object root (see `listActiveListings`). These pull a specific branch
 * back out so a test can assert what that branch says.
 */
const andBranches = (fn: jest.Mock): Array<Record<string, unknown>> =>
    (whereOf(fn).AND ?? []) as Array<Record<string, unknown>>;
const branchMentioning = (fn: jest.Mock, key: string) =>
    andBranches(fn).find((b) => JSON.stringify(b).includes(key));

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

        expect(whereOf(db.exchangeListing.findMany).status).toBe('ACTIVE');
        const expiry = branchMentioning(db.exchangeListing.findMany, 'expiresAt') as {
            OR: [{ expiresAt: null }, { expiresAt: { gt: Date } }];
        };
        expect(expiry.OR[0]).toEqual({ expiresAt: null });
        expect(expiry.OR[1].expiresAt.gt).toBeInstanceOf(Date);
    });

    it('keeps the expiry disjunction under AND so a second OR cannot displace it', async () => {
        // Break: moving the expiry clause back onto the `where` ROOT as
        // `where.OR`. Free-text search builds its own disjunction, and a
        // root-level assignment REPLACES rather than intersects — so the
        // moment a farmer typed in the search box every lapsed listing
        // would reappear. Both predicates have to be sibling AND branches.
        await ExchangeRepository.listActiveListings(asTx(db), { search: 'wheat' });

        expect(whereOf(db.exchangeListing.findMany).OR).toBeUndefined();
        expect(andBranches(db.exchangeListing.findMany)).toHaveLength(2);
        expect(branchMentioning(db.exchangeListing.findMany, 'expiresAt')).toBeDefined();
        expect(branchMentioning(db.exchangeListing.findMany, 'contains')).toBeDefined();
    });

    it('bounds the browse', async () => {
        // Break: removing `take`. There is no tenant filter on this table
        // — the cap is the ONLY bound on a public marketplace browse, and
        // its absence is a trivially reachable memory exhaustion.
        //
        // The cap is the default page size plus ONE: that extra row is the
        // "is there more?" probe the cursor pager trims back off, so the
        // page a caller receives is still exactly LISTING_PAGE_SIZE.
        await ExchangeRepository.listActiveListings(asTx(db));

        expect(argOf(db.exchangeListing.findMany).take).toBe(LISTING_PAGE_SIZE + 1);
        // `id` breaks createdAt ties; without it a cursor page boundary can
        // skip or repeat rows that share a timestamp.
        expect(argOf(db.exchangeListing.findMany).orderBy).toEqual([
            { createdAt: 'desc' },
            { id: 'desc' },
        ]);
    });

    it('never lets a caller-supplied page size lift the cap', async () => {
        // Break: trusting `page.limit`. It arrives from a query string, so
        // an unclamped read is the same unbounded browse with an extra step.
        await ExchangeRepository.listActiveListings(asTx(db), {}, { limit: 100_000 });

        expect(argOf(db.exchangeListing.findMany).take).toBe(LISTING_PAGE_MAX + 1);
    });

    it('adds no facet keys when no filters are supplied', async () => {
        await ExchangeRepository.listActiveListings(asTx(db));

        expect(Object.keys(whereOf(db.exchangeListing.findMany)).sort()).toEqual(['AND', 'status']);
    });

    it('selects facet values exactly — a facet is a chosen set, not a prefix', async () => {
        // Break: matching a facet with `contains`. Both of these are picked
        // from a catalogue of values that already exist in the table, so a
        // substring match is never what the farmer asked for: "Wheat" would
        // drag in "Wheat bran", and a region code substring would make
        // BG-3 match BG-31. Fuzziness belongs to `search` alone.
        await ExchangeRepository.listActiveListings(asTx(db), {
            commodities: ['Wheat'],
            regionCodes: ['BG-31'],
        });

        const where = whereOf(db.exchangeListing.findMany);
        expect(where.commodity).toEqual({ in: ['Wheat'] });
        expect(where.regionCode).toEqual({ in: ['BG-31'] });
        expect(JSON.stringify(where)).not.toContain('contains');
    });

    it('keeps free text fuzzy on the names but exact on the resolved codes', async () => {
        // The other half of the rule above. `search` is what a farmer typed,
        // so commodity and the stored region NAME are matched
        // case-insensitively — but the region codes the route resolved from
        // that term are still matched by set membership. Break: widening the
        // code arm to `contains` and BG-3 silently swallows BG-31 again.
        await ExchangeRepository.listActiveListings(asTx(db), {
            search: 'plovd',
            searchRegionCodes: ['BG-16'],
        });

        const search = branchMentioning(db.exchangeListing.findMany, 'contains') as {
            OR: unknown[];
        };
        expect(search.OR).toEqual([
            { commodity: { contains: 'plovd', mode: 'insensitive' } },
            { regionName: { contains: 'plovd', mode: 'insensitive' } },
            { regionCode: { in: ['BG-16'] } },
        ]);
    });

    it('carries every selected value of a multi-select facet', async () => {
        // Break: a scalar `where.side = filters.sides[0]`-shaped assignment,
        // or a `string`-typed enum plus a cast. The facets are multi-select
        // and comma-joined into one URL param, so the SECOND selected value
        // is where the bug shows: either it is silently ignored, or Prisma
        // throws a validation error the list page renders as its EMPTY
        // state — a farmer who ticks two crops sees no market at all.
        await ExchangeRepository.listActiveListings(asTx(db), {
            sides: ['SELL', 'BUY'],
            kinds: ['CULTURE', 'FERTILIZER'],
        });

        expect(whereOf(db.exchangeListing.findMany)).toMatchObject({
            side: { in: ['SELL', 'BUY'] },
            kind: { in: ['CULTURE', 'FERTILIZER'] },
        });
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
        await ExchangeRepository.listActiveListings(asTx(db), { sides: ['BUY'] });

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
    it('reads the buyer outbox off the inquiry’s own tenant column', async () => {
        // Break: `where: { listing: { sellerTenantId: tenantId } }`. The buyer
        // would be shown the inquiries they RECEIVED as a seller instead of
        // the ones they sent — and the swap is symmetric with the seller view
        // below, so both pages still render plausibly while showing each
        // party the other's half of the market.
        //
        // The listing has to come with it: `/my-interests` renders the crop,
        // the tonnage and the seller's response off `iq.listing`, so without
        // the relation the page is a list of empty rows.
        await ExchangeRepository.listInquiriesByInquirer(asTx(db), 'tenant-2');

        const arg = argOf(db.exchangeInquiry.findMany);
        expect(arg.where).toEqual({ inquirerTenantId: 'tenant-2' });
        expect(arg.include).toEqual({ listing: true });
        expect(arg.take).toBe(100);
    });

    it('reaches the seller’s inbox through the listing’s owner column', async () => {
        // The other side of that asymmetry. A seller's inquiries are not
        // reachable from any column on `ExchangeInquiry` — the inquiry knows
        // only who SENT it — so the seller's view is anchored on the
        // listing's `sellerTenantId` and picks the inquiries up through the
        // relation.
        //
        // Break: filtering the nested read by `inquirerTenantId` as well.
        // That reads as a tidy "scope it to me" and would empty the inbox of
        // every inquiry the seller did not send themselves — which is all of
        // them. The nested read is deliberately unfiltered: the parent
        // `where` has already established that these are the caller's own
        // listings, and every inquiry hanging off one of them is addressed
        // to the caller by construction.
        await ExchangeRepository.listListingsBySeller(asTx(db), 'tenant-1');

        const arg = argOf(db.exchangeListing.findMany);
        expect(arg.where).toEqual({ sellerTenantId: 'tenant-1' });
        expect(arg.include.inquiries.where).toBeUndefined();
        // Both levels bounded — the outer list AND the per-listing fan-out.
        expect(arg.take).toBe(100);
        expect(arg.include.inquiries.take).toBe(100);
        expect(arg.include.inquiries.orderBy).toEqual({ createdAt: 'desc' });
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
