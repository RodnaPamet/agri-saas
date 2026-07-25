/**
 * Enterprise-grain — org portfolio grain aggregation usecase tests.
 *
 * Covers `getPortfolioGrainSummary`:
 *   - cross-tenant aggregation: per-tenant aggregates roll up into org
 *     totals (SALE/PURCHASE contracted tonnes, yield, activity cost,
 *     bin capacity/stored/utilisation), with a per-tenant breakdown.
 *   - resilience: a child tenant with no grain contributes zeros and is
 *     not counted in `tenantsWithGrain`.
 *   - the `canViewPortfolio` gate refuses callers without the flag.
 *
 * Mocks the two seams the usecase stands on:
 *   - `getPortfolioData` (the memoised child-tenant list), and
 *   - `withTenantDb` (the RLS-bound per-tenant transaction) — the mock
 *     hands each callback a fake `db` whose aggregate/groupBy results
 *     are keyed by tenant id, so the test exercises the aggregation +
 *     rollup math without a live DB.
 */

const getPortfolioDataMock = jest.fn();

jest.mock('@/app-layer/usecases/portfolio-data', () => ({
    __esModule: true,
    getPortfolioData: (...a: unknown[]) => getPortfolioDataMock(...a),
}));

// Per-tenant canned aggregate results — keyed by tenant id.
interface FakeTenantData {
    /**
     * Raw contract rows (status + type + tonnes). The fake `groupBy`
     * APPLIES the query's `where.status.in` before grouping by type, so
     * a test proves the usecase's status filter for real instead of
     * trusting a canned group result. Set `contractGroups` instead to
     * hand back pre-grouped rows verbatim.
     */
    contracts?: Array<{ status: string; type: string; volumeTonnes: string }>;
    contractGroups?: Array<{ type: string; _sum: { volumeTonnes: string | null } }>;
    yieldSum: string | null;
    logCost: string | null;
    stockCost: string | null;
    bins: Array<{ id: string; capacityTonnes: string | null }>;
    stored: Array<{ locationId: string; _sum: { quantityOnHand: string | null } }>;
    currency: string | null;
}

const TENANT_DATA: Record<string, FakeTenantData> = {};

/** Every `contract.groupBy` arg object the usecase issued, in order —
 *  so a test can assert the WHERE shape, not just the result. */
const contractGroupByArgs: Array<Record<string, any>> = [];

function fakeDbFor(tenantId: string) {
    const d = TENANT_DATA[tenantId];
    return {
        contract: {
            groupBy: jest.fn(async (args: Record<string, any>) => {
                contractGroupByArgs.push(args);
                if (!d.contracts) return d.contractGroups ?? [];
                // Mimic the DB: filter by `where.status.in`, then SUM
                // volumeTonnes grouped by type.
                const allowed: string[] | undefined = args?.where?.status?.in;
                const byType = new Map<string, number>();
                for (const c of d.contracts) {
                    if (allowed && !allowed.includes(c.status)) continue;
                    byType.set(c.type, (byType.get(c.type) ?? 0) + Number(c.volumeTonnes));
                }
                return [...byType].map(([type, sum]) => ({
                    type,
                    _sum: { volumeTonnes: String(sum) },
                }));
            }),
            findFirst: jest.fn(async () =>
                d.currency ? { priceCurrency: d.currency } : null,
            ),
        },
        yieldRecord: { aggregate: jest.fn(async () => ({ _sum: { grossTonnes: d.yieldSum } })) },
        logEntry: { aggregate: jest.fn(async () => ({ _sum: { costAmount: d.logCost } })) },
        stockTransaction: { aggregate: jest.fn(async () => ({ _sum: { costAmount: d.stockCost } })) },
        location: { findMany: jest.fn(async () => d.bins) },
        inventoryLot: { groupBy: jest.fn(async () => d.stored) },
    };
}

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    withTenantDb: (tenantId: string, cb: (db: unknown) => unknown) => cb(fakeDbFor(tenantId)),
}));

import { getPortfolioGrainSummary } from '@/app-layer/usecases/portfolio-grain';
import type { OrgContext } from '@/app-layer/types';

function ctxFor(overrides: Partial<OrgContext> = {}): OrgContext {
    return {
        requestId: 'req-test',
        userId: 'user-1',
        organizationId: 'org-1',
        orgSlug: 'acme-org',
        orgRole: 'ORG_ADMIN',
        permissions: {
            canViewPortfolio: true,
            canDrillDown: true,
            canExportReports: true,
            canManageTenants: true,
            canManageMembers: true,
            canConfigureDashboard: true,
        },
        ...overrides,
    };
}

beforeEach(() => {
    getPortfolioDataMock.mockReset();
    for (const k of Object.keys(TENANT_DATA)) delete TENANT_DATA[k];
    contractGroupByArgs.length = 0;
});

describe('getPortfolioGrainSummary', () => {
    it('aggregates grain across child tenants into org totals + per-tenant rows', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [
                { id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' },
                { id: 'farm-b', name: 'Bravo Farm', slug: 'bravo' },
            ],
        });
        // Raw rows, deliberately mixed-status: 1600 tonnes across the two
        // farms are NOT live commitments and must not reach the totals.
        TENANT_DATA['farm-a'] = {
            contracts: [
                { status: 'ACTIVE', type: 'SALE', volumeTonnes: '500' },
                { status: 'DRAFT', type: 'SALE', volumeTonnes: '900' }, // unsigned
                { status: 'ACTIVE', type: 'PURCHASE', volumeTonnes: '120' },
                { status: 'CANCELLED', type: 'PURCHASE', volumeTonnes: '400' }, // void
            ],
            yieldSum: '420.5',
            logCost: '1000',
            stockCost: '250',
            bins: [{ id: 'bin-1', capacityTonnes: '1000' }],
            stored: [{ locationId: 'bin-1', _sum: { quantityOnHand: '600' } }],
            currency: 'EUR',
        };
        TENANT_DATA['farm-b'] = {
            contracts: [
                { status: 'DELIVERED', type: 'SALE', volumeTonnes: '300' },
                { status: 'SETTLED', type: 'SALE', volumeTonnes: '700' }, // closed out
            ],
            yieldSum: '180',
            logCost: '400',
            stockCost: null,
            bins: [{ id: 'bin-2', capacityTonnes: '500' }],
            stored: [{ locationId: 'bin-2', _sum: { quantityOnHand: '200' } }],
            currency: null,
        };

        const res = await getPortfolioGrainSummary(ctxFor());

        // Org totals.
        //
        // 500 (farm-a ACTIVE) + 300 (farm-b DELIVERED) = 800. The 900
        // DRAFT and 700 SETTLED sale tonnes are NOT commitments — an
        // unfiltered sum would read 2400 here.
        expect(res.totals.contractedSaleTonnes).toBe(800);
        // 120 ACTIVE; the 400 CANCELLED purchase tonnes are void.
        expect(res.totals.contractedPurchaseTonnes).toBe(120);
        expect(res.totals.totalYieldTonnes).toBe(600.5); // 420.5 + 180
        expect(res.totals.totalActivityCost).toBe(1650); // 1000+250 + 400
        expect(res.totals.binCount).toBe(2);
        expect(res.totals.binCapacityTonnes).toBe(1500);
        expect(res.totals.binStoredTonnes).toBe(800); // 600 + 200
        // 800 / 1500 × 100 = 53.3
        expect(res.totals.binUtilisationPct).toBeCloseTo(53.3, 1);
        expect(res.totals.currency).toBe('EUR'); // first non-null
        expect(res.totals.tenantsWithGrain).toBe(2);
        expect(res.totals.tenantsTotal).toBe(2);

        // Per-tenant breakdown, name-sorted.
        expect(res.perTenant.map((r) => r.tenantName)).toEqual(['Alpha Farm', 'Bravo Farm']);
        const alpha = res.perTenant.find((r) => r.tenantId === 'farm-a')!;
        expect(alpha.contractedSaleTonnes).toBe(500);
        expect(alpha.totalActivityCost).toBe(1250);
        expect(alpha.binStoredTonnes).toBe(600);
    });

    it('scopes the contract rollup to the live commitment statuses in the QUERY', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        TENANT_DATA['farm-a'] = {
            contracts: [{ status: 'ACTIVE', type: 'SALE', volumeTonnes: '10' }],
            yieldSum: null,
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: null,
        };

        await getPortfolioGrainSummary(ctxFor());

        // The filter is pushed DOWN into Prisma (not applied in JS after
        // the fact), still tenant-scoped and soft-delete aware.
        expect(contractGroupByArgs).toHaveLength(1);
        expect(contractGroupByArgs[0].where).toEqual({
            tenantId: 'farm-a',
            deletedAt: null,
            status: { in: ['ACTIVE', 'DELIVERED'] },
        });
        expect(contractGroupByArgs[0].by).toEqual(['type']);
    });

    it('excludes DRAFT and CANCELLED contracts from contracted tonnes', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'paper-farm', name: 'Paper Farm', slug: 'paper' }],
        });
        // Nothing signed, nothing live: a pile of unsigned drafts and a
        // cancelled deal. The headline commitment must be ZERO — before
        // the status filter this farm reported 1500 contracted tonnes.
        TENANT_DATA['paper-farm'] = {
            contracts: [
                { status: 'DRAFT', type: 'SALE', volumeTonnes: '600' },
                { status: 'DRAFT', type: 'SALE', volumeTonnes: '500' },
                { status: 'CANCELLED', type: 'SALE', volumeTonnes: '300' },
                { status: 'CANCELLED', type: 'PURCHASE', volumeTonnes: '100' },
            ],
            yieldSum: null,
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: null,
        };

        const res = await getPortfolioGrainSummary(ctxFor());

        expect(res.totals.contractedSaleTonnes).toBe(0);
        expect(res.totals.contractedPurchaseTonnes).toBe(0);
        expect(res.perTenant[0].contractedSaleTonnes).toBe(0);
        expect(res.perTenant[0].contractedPurchaseTonnes).toBe(0);
        // No live commitment + no other grain figure ⇒ not a grain farm
        // for portfolio purposes.
        expect(res.totals.tenantsWithGrain).toBe(0);
    });

    it('counts SETTLED as closed-out history, not a live commitment', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        // Last season's business is delivered AND paid. Including it made
        // the headline a lifetime total that could only ever grow.
        TENANT_DATA['farm-a'] = {
            contracts: [
                { status: 'SETTLED', type: 'SALE', volumeTonnes: '5000' },
                { status: 'ACTIVE', type: 'SALE', volumeTonnes: '250' },
                { status: 'DELIVERED', type: 'SALE', volumeTonnes: '150' },
            ],
            yieldSum: null,
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: null,
        };

        const res = await getPortfolioGrainSummary(ctxFor());

        // 250 ACTIVE + 150 DELIVERED; the 5000 SETTLED tonnes are history.
        expect(res.totals.contractedSaleTonnes).toBe(400);
    });

    it('a tenant with no grain contributes zeros and is excluded from tenantsWithGrain', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [
                { id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' },
                { id: 'empty', name: 'Empty Farm', slug: 'empty' },
            ],
        });
        TENANT_DATA['farm-a'] = {
            contractGroups: [{ type: 'SALE', _sum: { volumeTonnes: '100' } }],
            yieldSum: '50',
            logCost: '10',
            stockCost: null,
            bins: [],
            stored: [],
            currency: 'GBP',
        };
        TENANT_DATA['empty'] = {
            contractGroups: [],
            yieldSum: null,
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: null,
        };

        const res = await getPortfolioGrainSummary(ctxFor());

        expect(res.totals.tenantsTotal).toBe(2);
        expect(res.totals.tenantsWithGrain).toBe(1);
        expect(res.totals.binUtilisationPct).toBeNull(); // no capacity anywhere
        const empty = res.perTenant.find((r) => r.tenantId === 'empty')!;
        expect(empty.contractedSaleTonnes).toBe(0);
        expect(empty.totalYieldTonnes).toBe(0);
        expect(empty.totalActivityCost).toBe(0);
        expect(empty.binCount).toBe(0);
    });

    it('refuses a caller without canViewPortfolio', async () => {
        const ctx = ctxFor({
            permissions: {
                canViewPortfolio: false,
                canDrillDown: false,
                canExportReports: false,
                canManageTenants: false,
                canManageMembers: false,
                canConfigureDashboard: false,
            },
        });
        await expect(getPortfolioGrainSummary(ctx)).rejects.toThrow();
        expect(getPortfolioDataMock).not.toHaveBeenCalled();
    });
});
