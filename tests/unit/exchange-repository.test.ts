/**
 * Unit — ExchangeRepository.listActiveListings: the expiry filter, the
 * server-side facets, and the seller-module exclusion.
 *
 * The browse feed must hide an ACTIVE listing once it is past its expiry (until
 * the sweep flips it to EXPIRED). The repo builds
 *   status = ACTIVE  AND  (expiresAt IS NULL OR expiresAt > now)
 * These tests capture the `where` and evaluate it against sample rows the way
 * Postgres would, so a regression that drops the expiry clause is caught
 * WITHOUT needing a live DB (the local test DB can't run these migrations).
 *
 * The facet tests exist because the facets used to be dead code: the route
 * passed nothing and the client filtered a truncated array, so every filter
 * described the newest 100 offers nationwide. And the free-text search is
 * asserted to be ANDed rather than dropped onto the `where` root — a second
 * root-level `OR` would REPLACE the expiry clause and resurrect stale
 * listings the moment someone typed in the search box.
 */
import { Prisma, ExchangeListingStatus } from '@prisma/client';
import {
    ExchangeRepository,
    type ListingFilters,
    type ListingPageParams,
} from '@/app-layer/repositories/exchange';

interface Row { status: string; expiresAt: Date | null }

type ExpiryCond = { expiresAt?: null | { gt?: Date } };

/** Pull the expiry `OR` out of the captured `AND` list. */
function expiryClause(where: Prisma.ExchangeListingWhereInput): ExpiryCond[] | null {
    const and = where.AND as Array<{ OR?: ExpiryCond[] }> | undefined;
    if (!Array.isArray(and)) return null;
    for (const branch of and) {
        if (branch.OR?.some((c) => 'expiresAt' in c)) return branch.OR;
    }
    return null;
}

/** Evaluate the captured `where` against a row (mirrors Prisma null/gt semantics). */
function matches(where: Prisma.ExchangeListingWhereInput, row: Row): boolean {
    if (where.status && row.status !== where.status) return false;
    const or = expiryClause(where);
    if (or) {
        const ok = or.some((cond) => {
            if (!('expiresAt' in cond)) return false;
            if (cond.expiresAt === null) return row.expiresAt === null;
            if (cond.expiresAt?.gt) return row.expiresAt != null && row.expiresAt > cond.expiresAt.gt;
            return false;
        });
        if (!ok) return false;
    }
    return true;
}

interface Captured {
    where: Prisma.ExchangeListingWhereInput;
    args: { take?: number; cursor?: { id: string }; skip?: number; orderBy?: unknown };
}

/** Build a stub `db` whose findMany returns `rows`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubDb(rows: Array<{ id: string }>, sink?: (args: any) => void): any {
    return {
        exchangeListing: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            findMany: (args: any) => {
                sink?.(args);
                return Promise.resolve(rows);
            },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

function capture(
    filters: ListingFilters = {},
    page: ListingPageParams = {},
    rows: Array<{ id: string }> = [],
): Promise<Captured> {
    let captured: Captured = { where: {}, args: {} };
    const db = stubDb(rows, (args) => {
        captured = { where: args.where, args };
    });
    return ExchangeRepository.listActiveListings(db, filters, page).then(() => captured);
}

describe('listActiveListings — expiry filter', () => {
    const past = new Date('2020-01-01T00:00:00Z');
    const future = new Date('2999-01-01T00:00:00Z');

    it('restricts to ACTIVE + the null-or-future expiry clause', async () => {
        const { where } = await capture();
        expect(where.status).toBe(ExchangeListingStatus.ACTIVE);
        expect(expiryClause(where)).toHaveLength(2);
    });

    it('EXCLUDES an ACTIVE row whose expiresAt is in the past', async () => {
        const { where } = await capture();
        expect(matches(where, { status: 'ACTIVE', expiresAt: past })).toBe(false);
    });

    it('INCLUDES an ACTIVE row with a null or future expiry', async () => {
        const { where } = await capture();
        expect(matches(where, { status: 'ACTIVE', expiresAt: null })).toBe(true);
        expect(matches(where, { status: 'ACTIVE', expiresAt: future })).toBe(true);
    });

    it('EXCLUDES a non-ACTIVE row even with a future expiry', async () => {
        const { where } = await capture();
        expect(matches(where, { status: 'WITHDRAWN', expiresAt: future })).toBe(false);
        expect(matches(where, { status: 'EXPIRED', expiresAt: future })).toBe(false);
    });

    it('SURVIVES a free-text search (search is ANDed, not dropped on the root)', async () => {
        const { where } = await capture({ search: 'wheat' });
        // The regression this guards: assigning `where.OR = [...search]` would
        // overwrite the expiry disjunction, so searching would silently show
        // lapsed listings again.
        expect(matches(where, { status: 'ACTIVE', expiresAt: past })).toBe(false);
        expect(matches(where, { status: 'ACTIVE', expiresAt: null })).toBe(true);
    });
});

describe('listActiveListings — server-side facets', () => {
    it('translates multi-select facets into `in` filters', async () => {
        const { where } = await capture({
            sides: ['SELL', 'BUY'],
            kinds: ['CULTURE'],
            commodities: ['Wheat', 'Barley'],
            regionCodes: ['BG-08', 'BG-16'],
        });
        expect(where.side).toEqual({ in: ['SELL', 'BUY'] });
        expect(where.kind).toEqual({ in: ['CULTURE'] });
        expect(where.commodity).toEqual({ in: ['Wheat', 'Barley'] });
        expect(where.regionCode).toEqual({ in: ['BG-08', 'BG-16'] });
    });

    it('OMITS a facet whose array is empty (a cleared facet must not match nothing)', async () => {
        const { where } = await capture({ sides: [], commodities: [] });
        expect(where.side).toBeUndefined();
        expect(where.commodity).toBeUndefined();
    });

    it('applies tonnage bounds', async () => {
        const { where } = await capture({ minTonnes: 10, maxTonnes: 500 });
        expect(where.quantityTonnes).toEqual({ gte: 10, lte: 500 });
    });

    it('searches commodity, the stored region name, AND the matched region codes', async () => {
        const { where } = await capture({ search: 'Пловдив', searchRegionCodes: ['BG-16'] });
        const and = where.AND as Array<{ OR?: unknown[] }>;
        const searchBranch = and.find((b) => JSON.stringify(b).includes('contains'));
        // The row stores the ENGLISH region name, so a Bulgarian search term
        // has to reach it through the resolved code.
        expect(JSON.stringify(searchBranch)).toContain('BG-16');
        expect(JSON.stringify(searchBranch)).toContain('commodity');
        expect(JSON.stringify(searchBranch)).toContain('regionName');
    });

    it('excludes sellers who switched the EXCHANGE module off', async () => {
        const { where } = await capture({ excludeSellerTenantIds: ['tenant-off'] });
        expect(where.sellerTenantId).toEqual({ notIn: ['tenant-off'] });
    });

    it('omits the seller exclusion when nobody has opted out', async () => {
        const { where } = await capture({ excludeSellerTenantIds: [] });
        expect(where.sellerTenantId).toBeUndefined();
    });
});

describe('listActiveListings — cursor pagination', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `l${i}` }));

    it('over-fetches by one to detect a next page, and trims it off', async () => {
        const { args } = await capture({}, { limit: 3 }, rows(4));
        expect(args.take).toBe(4);
        const page = await ExchangeRepository.listActiveListings(stubDb(rows(4)), {}, { limit: 3 });
        expect(page.rows).toHaveLength(3);
        expect(page.nextCursor).toBe('l2');
    });

    it('reports no next cursor on a short (final) page', async () => {
        const page = await ExchangeRepository.listActiveListings(stubDb(rows(2)), {}, { limit: 3 });
        expect(page.rows).toHaveLength(2);
        expect(page.nextCursor).toBeNull();
    });

    it('skips the cursor row itself and breaks createdAt ties by id', async () => {
        const { args } = await capture({}, { limit: 10, cursor: 'l9' });
        expect(args.cursor).toEqual({ id: 'l9' });
        expect(args.skip).toBe(1);
        // Without the id tiebreak, listings sharing a createdAt could be
        // skipped or repeated across page boundaries.
        expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('clamps an over-large requested limit', async () => {
        const { args } = await capture({}, { limit: 10_000 });
        expect(args.take).toBeLessThanOrEqual(101);
    });
});

describe('listTenantIdsWithModuleDisabled', () => {
    it('selects only tenantId, bounded, for rows NOT listing the module', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let captured: any = null;
        const db = {
            tenantModuleSettings: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                findMany: (args: any) => {
                    captured = args;
                    return Promise.resolve([{ tenantId: 't-off' }]);
                },
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;

        const ids = await ExchangeRepository.listTenantIdsWithModuleDisabled(db, 'EXCHANGE');

        expect(ids).toEqual(['t-off']);
        expect(captured.where).toEqual({ NOT: { enabledModules: { has: 'EXCHANGE' } } });
        // Nothing but the id: this is a cross-tenant read, so it must not be
        // able to grow into one that returns other tenants' settings.
        expect(captured.select).toEqual({ tenantId: true });
        expect(typeof captured.take).toBe('number');
    });
});
