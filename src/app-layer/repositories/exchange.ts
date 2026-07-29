import { PrismaTx } from '@/lib/db-context';
import {
    Prisma,
    ExchangeSide,
    ExchangeKind,
    ExchangeListingStatus,
    ExchangeInquiryStatus,
    ModuleKey,
} from '@prisma/client';

/**
 * Exchange repository — all Prisma queries for the cross-tenant marketplace.
 *
 * CRITICAL: unlike every other repository in this codebase, these reads are
 * GLOBAL — they DELIBERATELY do NOT filter by `tenantId`. The Exchange's
 * whole purpose is that tenants read each other's offers, so
 * `ExchangeListing` / `ExchangeInquiry` are global tables (no `tenantId`
 * column, no RLS — see prisma/schema/exchange.prisma). Cross-tenant WRITE
 * safety is therefore enforced ONE layer up, in
 * `src/app-layer/usecases/exchange.ts` (every mutation asserts
 * `ctx.tenantId === listing.sellerTenantId`) — never here.
 *
 * These methods take `db` + explicit params (NOT a `RequestContext`) exactly
 * because there is no tenant axis to scope by; the caller-tenant filters on
 * the inquiry lists are ordinary "my rows" views, not isolation.
 */

/** Bounded read cap (query-shape guardrail D2 forbids unbounded findMany). */
const LIST_TAKE = 100;

/** Default browse page size, and the ceiling a caller may request. */
export const LISTING_PAGE_SIZE = 50;
export const LISTING_PAGE_MAX = 100;

/**
 * How many module opt-outs the exclusion list will carry. A
 * `TenantModuleSettings` row exists ONLY for a tenant that customised its
 * module list, and this reads the subset of those that switched one module
 * OFF — a small set by construction. If it ever saturates, the honest fix is
 * a denormalised flag on the listing, not a bigger number here.
 */
const MODULE_OPTOUT_TAKE = 1000;

/**
 * Browse facets. Every field is an ARRAY because the UI's facets are
 * multi-select: `filterStateToUrlParams` comma-joins them into one param, so
 * the route parses `?side=SELL,BUY` into a real array and queries with
 * `{ in: [...] }`. A `string`-typed enum field plus a cast is the shape that
 * throws `PrismaClientValidationError` on the second selected value — a 500
 * the list page renders as its EMPTY state.
 */
export interface ListingFilters {
    sides?: ExchangeSide[];
    kinds?: ExchangeKind[];
    commodities?: string[];
    regionCodes?: string[];
    minTonnes?: number;
    maxTonnes?: number;
    /** Free-text search over commodity + region name. */
    search?: string;
    /**
     * Region codes whose (Bulgarian OR English) name matched `search` — the
     * route resolves them from the oblast catalogue so a Bulgarian farmer
     * searching "Пловдив" matches a row whose stored `regionName` is the
     * English "Plovdiv".
     */
    searchRegionCodes?: string[];
    /**
     * Seller tenants to hide — the tenants that switched the EXCHANGE module
     * OFF. See `listTenantIdsWithModuleDisabled`.
     */
    excludeSellerTenantIds?: string[];
}

export interface ListingPageParams {
    /** Page size (clamped to LISTING_PAGE_MAX by the caller). */
    limit?: number;
    /** Id of the last row on the previous page. */
    cursor?: string | null;
}

export class ExchangeRepository {
    /**
     * Tenant ids that have switched `key` OFF.
     *
     * MUST be called with an RLS-BYPASSING client (`runInGlobalContext`):
     * `TenantModuleSettings` is tenant-scoped and RLS-forced, so under the
     * caller's own `app_user` context this would return at most the caller's
     * own row and the exclusion would silently do nothing.
     *
     * The cross-tenant read is narrow on purpose — `select: { tenantId: true }`
     * and nothing else. It reads WHICH tenants opted out, never a single byte
     * of their data, and the Exchange feed is already a deliberately
     * cross-tenant read; this is the same class of query.
     */
    static async listTenantIdsWithModuleDisabled(
        db: PrismaTx,
        key: ModuleKey,
    ): Promise<string[]> {
        const rows = await db.tenantModuleSettings.findMany({
            // A row that does NOT list the key has the module off. Tenants
            // with no row at all have every module enabled, so they are
            // correctly absent from this result.
            where: { NOT: { enabledModules: { has: key } } },
            select: { tenantId: true },
            take: MODULE_OPTOUT_TAKE,
        });
        return rows.map((r) => r.tenantId);
    }

    /**
     * GLOBAL browse of ACTIVE, not-yet-expired listings across ALL tenants,
     * newest first, with server-side facets and cursor pagination.
     *
     * The facets used to exist here and go unused: the route passed nothing
     * and the client filtered the fetched array, so every filter, every count
     * and every market statistic described only the newest 100 offers
     * NATIONWIDE rather than the market the farmer asked about. They are wired
     * now, so a filtered query is answered by Postgres over the whole table.
     */
    static async listActiveListings(
        db: PrismaTx,
        filters: ListingFilters = {},
        page: ListingPageParams = {},
    ) {
        // Every extra predicate goes in `AND` rather than onto the object
        // root: the expiry clause is itself an `OR`, and a second root-level
        // `OR` (free-text search) would REPLACE it — quietly resurrecting
        // expired listings the moment someone typed in the search box.
        const and: Prisma.ExchangeListingWhereInput[] = [
            // An ACTIVE row past its expiry is stale — hide it until the
            // sweep flips it to EXPIRED.
            { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        ];

        const where: Prisma.ExchangeListingWhereInput = {
            status: ExchangeListingStatus.ACTIVE,
            AND: and,
        };
        if (filters.sides?.length) where.side = { in: filters.sides };
        if (filters.kinds?.length) where.kind = { in: filters.kinds };
        if (filters.commodities?.length) where.commodity = { in: filters.commodities };
        if (filters.regionCodes?.length) where.regionCode = { in: filters.regionCodes };
        if (filters.excludeSellerTenantIds?.length) {
            where.sellerTenantId = { notIn: filters.excludeSellerTenantIds };
        }
        if (filters.minTonnes != null || filters.maxTonnes != null) {
            where.quantityTonnes = {
                ...(filters.minTonnes != null ? { gte: filters.minTonnes } : {}),
                ...(filters.maxTonnes != null ? { lte: filters.maxTonnes } : {}),
            };
        }
        if (filters.search) {
            and.push({
                OR: [
                    { commodity: { contains: filters.search, mode: 'insensitive' } },
                    { regionName: { contains: filters.search, mode: 'insensitive' } },
                    ...(filters.searchRegionCodes?.length
                        ? [{ regionCode: { in: filters.searchRegionCodes } }]
                        : []),
                ],
            });
        }

        const limit = Math.min(page.limit ?? LISTING_PAGE_SIZE, LISTING_PAGE_MAX);
        const rows = await db.exchangeListing.findMany({
            where,
            // `id` breaks createdAt ties so the cursor cannot skip or repeat a
            // row when several listings share a timestamp.
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            // One extra row is the "is there more?" probe — cheaper and more
            // accurate than a second COUNT over the same predicate.
            take: limit + 1,
            ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
        });

        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        return {
            rows: pageRows,
            nextCursor: hasMore ? pageRows[pageRows.length - 1].id : null,
        };
    }

    /** GLOBAL read of a single listing by id (any tenant's). */
    static async getListing(db: PrismaTx, id: string) {
        return db.exchangeListing.findUnique({ where: { id } });
    }

    /** Create a listing. Ownership fields (`sellerTenantId`/`sellerUserId`) are
     *  set by the usecase from the request context. */
    static async createListing(
        db: PrismaTx,
        data: Prisma.ExchangeListingUncheckedCreateInput,
    ) {
        return db.exchangeListing.create({ data });
    }

    /** Flip a listing's lifecycle status (FULFILLED / WITHDRAWN / EXPIRED). */
    static async updateListingStatus(
        db: PrismaTx,
        id: string,
        status: ExchangeListingStatus,
    ) {
        return db.exchangeListing.update({ where: { id }, data: { status } });
    }

    /** Create an inquiry against a listing. */
    static async createInquiry(
        db: PrismaTx,
        data: Prisma.ExchangeInquiryUncheckedCreateInput,
    ) {
        return db.exchangeInquiry.create({ data });
    }

    /**
     * Inquiries SENT by `inquirerTenantId` (the buyer's outbox), newest
     * first. Scoped by the inquirer's own tenant. Bounded.
     */
    static async listInquiriesByInquirer(db: PrismaTx, inquirerTenantId: string) {
        return db.exchangeInquiry.findMany({
            where: { inquirerTenantId },
            orderBy: { createdAt: 'desc' },
            take: LIST_TAKE,
            include: { listing: true },
        });
    }

    /**
     * All listings OWNED by `sellerTenantId` (any status), newest first, each
     * with its inquiries. The seller's "my listings" management view.
     * Bounded.
     */
    static async listListingsBySeller(db: PrismaTx, sellerTenantId: string) {
        return db.exchangeListing.findMany({
            where: { sellerTenantId },
            orderBy: { createdAt: 'desc' },
            take: LIST_TAKE,
            include: {
                inquiries: { orderBy: { createdAt: 'desc' }, take: LIST_TAKE },
            },
        });
    }

    /** Single inquiry by id, with its listing (for the seller ownership guard). */
    static async getInquiry(db: PrismaTx, id: string) {
        return db.exchangeInquiry.findUnique({
            where: { id },
            include: { listing: true },
        });
    }

    /**
     * Flip an inquiry's status (ACCEPTED / DECLINED) and stamp the consent.
     *
     * `contactSharedAt` travels with the status in ONE update rather than a
     * follow-up write: the pair is what the reveal gate reads, and a window
     * where an inquiry is ACCEPTED but not yet shared would show a buyer an
     * accepted deal with no way to reach anyone. The DB CHECK constraint
     * (`contactSharedAt IS NULL OR status = 'ACCEPTED'`) refuses the
     * inconsistent pair, so this signature cannot be misused into producing a
     * declined-but-shared row.
     */
    static async updateInquiryStatus(
        db: PrismaTx,
        id: string,
        status: ExchangeInquiryStatus,
        contactSharedAt: Date | null,
    ) {
        return db.exchangeInquiry.update({
            where: { id },
            data: { status, contactSharedAt },
        });
    }

    /**
     * Decline every still-PENDING inquiry on a listing, returning who was
     * affected so they can be told.
     *
     * Used when a listing reaches a terminal state: the goods are gone, so the
     * honest outcome for anyone still waiting is a decline rather than an
     * inquiry that stays pending forever. The ids are read BEFORE the update
     * because `updateMany` returns only a count, and a count cannot be
     * notified.
     */
    static async declinePendingInquiries(db: PrismaTx, listingId: string) {
        const pending = await db.exchangeInquiry.findMany({
            where: { listingId, status: ExchangeInquiryStatus.PENDING },
            select: { id: true, inquirerTenantId: true },
            take: 200,
        });
        if (pending.length === 0) return [];
        await db.exchangeInquiry.updateMany({
            where: { id: { in: pending.map((p) => p.id) } },
            data: { status: ExchangeInquiryStatus.DECLINED },
        });
        return pending;
    }
}
