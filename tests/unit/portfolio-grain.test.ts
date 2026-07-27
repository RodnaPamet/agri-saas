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
/** Default catalog: every fixture quantity is tonnes unless it says otherwise. */
const TONNE_UNITS = [{ id: 'unit-t', key: 't', symbol: 't' }];
const KG_UNIT = { id: 'unit-kg', key: 'kg', symbol: 'kg' };

interface FakeTenantData {
    /**
     * Raw contract rows (status + type + tonnes). The fake `groupBy`
     * APPLIES the query's `where.status.in` before grouping by type, so
     * a test proves the usecase's status filter for real instead of
     * trusting a canned group result. Set `contractGroups` instead to
     * hand back pre-grouped rows verbatim.
     */
    contracts?: Array<{
        status: string;
        type: string;
        volumeTonnes: string;
        seasonId?: string | null;
        pricePerTonne?: string;
        priceCurrency?: string;
    }>;
    /** Season id → name, for the per-season rollup. */
    seasons?: Array<{ id: string; name: string }>;
    /** Yield rows keyed by season, for contracted-vs-produced. */
    yieldBySeason?: Array<{ seasonId: string | null; grossTonnes: string }>;
    contractGroups?: Array<{ type: string; _sum: { volumeTonnes: string | null } }>;
    yieldSum: string | null;
    /**
     * Σ grossTonnes over yield records that came from a journal HARVEST
     * (logEntryId IS NOT NULL) — the production/stock OVERLAP. Defaults to
     * null, i.e. none of the production is linked to store.
     */
    yieldFromJournalSum?: string | null;
    /** Currencies the tenant's activity cost was recorded in. */
    costCurrencies?: string[];
    logCost: string | null;
    stockCost: string | null;
    bins: Array<{ id: string; capacityTonnes: string | null }>;
    /** groupBy(['locationId','unitId']) rows — a lot's quantity is in ITS unit. */
    stored: Array<{
        locationId: string;
        unitId: string;
        _sum: { quantityOnHand: string | null };
        _count: { _all: number };
    }>;
    /** The `Unit` rows those unitIds resolve to (global table, no RLS). */
    units?: Array<{ id: string; key: string; symbol: string }>;
    currency: string | null;
}

const TENANT_DATA: Record<string, FakeTenantData> = {};
/** Captured `location.findMany` args, so a test can assert the pushed-down filter. */
const locationFindManyArgs: Array<{ where: Record<string, unknown> }> = [];

/** Every `contract.groupBy` arg object the usecase issued, in order —
 *  so a test can assert the WHERE shape, not just the result. */
const contractGroupByArgs: Array<Record<string, any>> = [];

/** Every `yieldRecord.aggregate` arg object, in order — production and the
 *  journal-linked subset are two different questions and a test should be
 *  able to prove BOTH were asked. */
const yieldAggregateArgs: Array<Record<string, any>> = [];

function fakeDbFor(tenantId: string) {
    const d = TENANT_DATA[tenantId];
    return {
        contract: {
            groupBy: jest.fn(async (args: Record<string, any>) => {
                contractGroupByArgs.push(args);
                const allowed: string[] | undefined = args?.where?.status?.in;
                const typeFilter: string | undefined = args?.where?.type;

                // The per-SEASON rollup groups by seasonId.
                if (args?.by?.[0] === 'seasonId') {
                    const bySeason = new Map<string | null, number>();
                    for (const c of d.contracts ?? []) {
                        if (allowed && !allowed.includes(c.status)) continue;
                        if (typeFilter && c.type !== typeFilter) continue;
                        const key = c.seasonId ?? null;
                        bySeason.set(key, (bySeason.get(key) ?? 0) + Number(c.volumeTonnes));
                    }
                    return [...bySeason].map(([seasonId, sum]) => ({
                        seasonId,
                        _sum: { volumeTonnes: String(sum) },
                    }));
                }

                if (!d.contracts) return d.contractGroups ?? [];
                // Mimic the DB: filter by `where.status.in`, then SUM
                // volumeTonnes grouped by type.
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
            // Feeds the contract-VALUE rollup (a per-row product Prisma
            // cannot SUM) and, via `where.status`, proves the live-book
            // scoping reaches that read too.
            findMany: jest.fn(async (args: Record<string, any>) => {
                if (!d.contracts) return [];
                const allowed: string[] | undefined = args?.where?.status?.in;
                return d.contracts
                    .filter((c) => !allowed || allowed.includes(c.status))
                    .map((c) => ({
                        status: c.status,
                        volumeTonnes: c.volumeTonnes,
                        pricePerTonne: c.pricePerTonne ?? null,
                        priceCurrency: c.priceCurrency ?? d.currency ?? null,
                    }));
            }),
        },
        season: {
            findMany: jest.fn(async () =>
                (d.seasons ?? []).map((s) => ({ id: s.id, name: s.name })),
            ),
        },
        yieldRecord: {
            // Two aggregates now run over YieldRecord: total production and
            // the journal-linked subset. Discriminate on the `where` so a
            // test proves the usecase asked the right question, rather than
            // both calls getting the same canned sum.
            aggregate: jest.fn(async (args: any) => {
                yieldAggregateArgs.push(args ?? {});
                return ({
                    _sum: {
                        grossTonnes: args?.where?.logEntryId
                            ? (d.yieldFromJournalSum ?? null)
                            : d.yieldSum,
                    },
                });
            }),
            groupBy: jest.fn(async () =>
                (d.yieldBySeason ?? []).map((y) => ({
                    seasonId: y.seasonId,
                    _sum: { grossTonnes: y.grossTonnes },
                })),
            ),
        },
        logEntry: {
            aggregate: jest.fn(async () => ({ _sum: { costAmount: d.logCost } })),
            // Activity cost now reports the currencies it was RECORDED in,
            // instead of borrowing a label from the oldest contract.
            findMany: jest.fn(async () => (d.costCurrencies ?? []).map((c) => ({ costCurrency: c }))),
        },
        stockTransaction: {
            aggregate: jest.fn(async () => ({ _sum: { costAmount: d.stockCost } })),
            findMany: jest.fn(async () => []),
        },
        location: {
            findMany: jest.fn(async (args: unknown) => {
                locationFindManyArgs.push(args as { where: Record<string, unknown> });
                return d.bins;
            }),
        },
        inventoryLot: { groupBy: jest.fn(async () => d.stored) },
        unit: { findMany: jest.fn(async () => d.units ?? TONNE_UNITS) },
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
    locationFindManyArgs.length = 0;
    contractGroupByArgs.length = 0;
    yieldAggregateArgs.length = 0;
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
            stored: [{ locationId: 'bin-1', unitId: 'unit-t', _sum: { quantityOnHand: '600' }, _count: { _all: 1 } }],
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
            stored: [{ locationId: 'bin-2', unitId: 'unit-t', _sum: { quantityOnHand: '200' }, _count: { _all: 1 } }],
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
        const byType = contractGroupByArgs.filter((a) => a.by?.[0] === 'type');
        expect(byType).toHaveLength(1);
        expect(byType[0].where).toEqual({
            tenantId: 'farm-a',
            deletedAt: null,
            status: { in: ['ACTIVE', 'DELIVERED'] },
        });

        // The per-SEASON rollup is a SEPARATE groupBy with a WIDER
        // status set — the live book and "what did I sell against this
        // harvest" are different questions.
        const bySeason = contractGroupByArgs.filter((a) => a.by?.[0] === 'seasonId');
        expect(bySeason).toHaveLength(1);
        expect(bySeason[0].where).toEqual({
            tenantId: 'farm-a',
            deletedAt: null,
            type: 'SALE',
            status: { in: ['ACTIVE', 'DELIVERED', 'SETTLED'] },
        });
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

    it('excludes ARCHIVED bins from org capacity metrics', async () => {
        // An archived bin is retired storage. Counting it deflated
        // binUtilisationPct and inflated binCount/binCapacityTonnes for the
        // whole org. The per-tenant bins PAGE still shows archived bins —
        // this is the metrics view.
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        TENANT_DATA['farm-a'] = {
            contractGroups: [], yieldSum: null, logCost: null, stockCost: null,
            bins: [{ id: 'bin-1', capacityTonnes: '100' }],
            stored: [], currency: null,
        };

        await getPortfolioGrainSummary(ctxFor());

        // The filter is pushed DOWN into the query, not applied after.
        const binArgs = locationFindManyArgs[0];
        expect(binArgs.where.status).toBe('ACTIVE');
    });

    it('converts non-tonne stock into tonnes before it reaches the org summary', async () => {
        // Regression: the grouped sum ignored each lot's unit, so a tenant
        // whose produce items default to kg reported 1000x its real tonnage
        // — into the CROSS-TENANT executive summary, where it also inflated
        // binUtilisationPct against a tonnes-denominated capacity.
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-kg', name: 'Kilo Farm', slug: 'kilo' }],
        });
        TENANT_DATA['farm-kg'] = {
            contractGroups: [],
            yieldSum: null,
            logCost: null,
            stockCost: null,
            bins: [{ id: 'bin-kg', capacityTonnes: '500' }],
            // 320 kg — the shipped demo-data shape (seed-demo.ts).
            stored: [
                {
                    locationId: 'bin-kg',
                    unitId: 'unit-kg',
                    _sum: { quantityOnHand: '320' },
                    _count: { _all: 2 },
                },
            ],
            units: [KG_UNIT],
            currency: null,
        };

        const res = await getPortfolioGrainSummary(ctxFor());

        // 320 kg = 0.32 t — NOT 320.
        expect(res.totals.binStoredTonnes).toBe(0.32);
        // 0.32 / 500 = 0.064%, which the metric rounds to 1dp → 0.1.
        // The old code reported 64% for this same bin.
        expect(res.totals.binUtilisationPct).toBe(0.1);
        expect(res.perTenant[0].binStoredTonnes).toBe(0.32);
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

// ─────────────────────────────────────────────────────────────────────
//  Per-season contracted-vs-produced (the seasonId promise)
// ─────────────────────────────────────────────────────────────────────
//
// `Contract.seasonId` has described a "portfolio rollup: contracted-vs-
// produced per season" since the module shipped, and the usecase had no
// season dimension at all — contracted tonnes and harvested tonnes
// rendered as two unrelated tiles. These lock the rollup that closes it.

describe('getPortfolioGrainSummary — perSeason', () => {
    it('pairs contracted against produced tonnes for each season', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        TENANT_DATA['farm-a'] = {
            contracts: [
                { status: 'ACTIVE', type: 'SALE', volumeTonnes: '400', seasonId: 's-2026' },
                { status: 'SETTLED', type: 'SALE', volumeTonnes: '600', seasonId: 's-2025' },
            ],
            seasons: [
                { id: 's-2026', name: '2026 Harvest' },
                { id: 's-2025', name: '2025 Harvest' },
            ],
            yieldBySeason: [
                { seasonId: 's-2026', grossTonnes: '800' },
                { seasonId: 's-2025', grossTonnes: '500' },
            ],
            yieldSum: '1300',
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: 'EUR',
        };

        const res = await getPortfolioGrainSummary(ctxFor());

        expect(res.perSeason).toHaveLength(2);
        // Newest season name first.
        expect(res.perSeason.map((s) => s.seasonName)).toEqual([
            '2026 Harvest',
            '2025 Harvest',
        ]);

        const y2026 = res.perSeason[0];
        expect(y2026.contractedSaleTonnes).toBe(400);
        expect(y2026.producedTonnes).toBe(800);
        expect(y2026.coveragePct).toBe(50); // half the harvest pre-sold
        expect(y2026.deltaTonnes).toBe(400); // unsold surplus
    });

    it('counts SETTLED contracts in the season view — unlike the live book', async () => {
        // The judgment call: a completed season's contracts are mostly
        // SETTLED. Scoring it against the live-book set would report ~0%
        // coverage for exactly the seasons an operator reviews.
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        TENANT_DATA['farm-a'] = {
            contracts: [
                { status: 'SETTLED', type: 'SALE', volumeTonnes: '900', seasonId: 's-2025' },
            ],
            seasons: [{ id: 's-2025', name: '2025 Harvest' }],
            yieldBySeason: [{ seasonId: 's-2025', grossTonnes: '1000' }],
            yieldSum: '1000',
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: null,
        };

        const res = await getPortfolioGrainSummary(ctxFor());

        expect(res.perSeason[0].contractedSaleTonnes).toBe(900);
        expect(res.perSeason[0].coveragePct).toBe(90);
        // …while the live-book headline correctly ignores it.
        expect(res.totals.contractedSaleTonnes).toBe(0);
    });

    it('still excludes DRAFT and CANCELLED from the season view', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        TENANT_DATA['farm-a'] = {
            contracts: [
                { status: 'ACTIVE', type: 'SALE', volumeTonnes: '100', seasonId: 's-1' },
                { status: 'DRAFT', type: 'SALE', volumeTonnes: '900', seasonId: 's-1' },
                { status: 'CANCELLED', type: 'SALE', volumeTonnes: '900', seasonId: 's-1' },
            ],
            seasons: [{ id: 's-1', name: '2026 Harvest' }],
            yieldBySeason: [{ seasonId: 's-1', grossTonnes: '200' }],
            yieldSum: '200',
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: null,
        };

        const res = await getPortfolioGrainSummary(ctxFor());
        expect(res.perSeason[0].contractedSaleTonnes).toBe(100);
        expect(res.perSeason[0].coveragePct).toBe(50);
    });

    it('flags over-commitment ABOVE 100% rather than clamping it', async () => {
        // Selling more than you grew is the single most actionable thing
        // this table can surface; clamping to 100% would hide it.
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        TENANT_DATA['farm-a'] = {
            contracts: [
                { status: 'ACTIVE', type: 'SALE', volumeTonnes: '1200', seasonId: 's-1' },
            ],
            seasons: [{ id: 's-1', name: '2026 Harvest' }],
            yieldBySeason: [{ seasonId: 's-1', grossTonnes: '1000' }],
            yieldSum: '1000',
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: null,
        };

        const res = await getPortfolioGrainSummary(ctxFor());
        expect(res.perSeason[0].coveragePct).toBe(120);
        expect(res.perSeason[0].deltaTonnes).toBe(-200); // short
    });

    it('reports NO coverage when nothing was produced', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        TENANT_DATA['farm-a'] = {
            contracts: [
                { status: 'ACTIVE', type: 'SALE', volumeTonnes: '500', seasonId: 's-1' },
            ],
            seasons: [{ id: 's-1', name: '2026 Harvest' }],
            yieldBySeason: [],
            yieldSum: null,
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: null,
        };

        const res = await getPortfolioGrainSummary(ctxFor());
        // A percentage of zero is undefined, not 0%.
        expect(res.perSeason[0].coveragePct).toBeNull();
        expect(res.perSeason[0].deltaTonnes).toBe(-500);
    });

    it('aggregates the same season NAME across child tenants', async () => {
        // Seasons are per-tenant rows, so "2026 Harvest" is a different
        // id in each farm. Group level means by name.
        getPortfolioDataMock.mockResolvedValue({
            tenants: [
                { id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' },
                { id: 'farm-b', name: 'Bravo Farm', slug: 'bravo' },
            ],
        });
        const base = {
            yieldSum: null,
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: null,
        };
        TENANT_DATA['farm-a'] = {
            ...base,
            contracts: [{ status: 'ACTIVE', type: 'SALE', volumeTonnes: '100', seasonId: 'a-26' }],
            seasons: [{ id: 'a-26', name: '2026 Harvest' }],
            yieldBySeason: [{ seasonId: 'a-26', grossTonnes: '150' }],
        };
        TENANT_DATA['farm-b'] = {
            ...base,
            contracts: [{ status: 'ACTIVE', type: 'SALE', volumeTonnes: '200', seasonId: 'b-26' }],
            seasons: [{ id: 'b-26', name: '2026 Harvest' }],
            yieldBySeason: [{ seasonId: 'b-26', grossTonnes: '250' }],
        };

        const res = await getPortfolioGrainSummary(ctxFor());

        expect(res.perSeason).toHaveLength(1);
        expect(res.perSeason[0].seasonName).toBe('2026 Harvest');
        expect(res.perSeason[0].contractedSaleTonnes).toBe(300);
        expect(res.perSeason[0].producedTonnes).toBe(400);
        expect(res.perSeason[0].tenantCount).toBe(2);
    });

    it('buckets season-less rows separately and sorts them last', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        TENANT_DATA['farm-a'] = {
            contracts: [
                { status: 'ACTIVE', type: 'SALE', volumeTonnes: '50', seasonId: null },
                { status: 'ACTIVE', type: 'SALE', volumeTonnes: '100', seasonId: 's-1' },
            ],
            seasons: [{ id: 's-1', name: '2026 Harvest' }],
            yieldBySeason: [{ seasonId: null, grossTonnes: '70' }],
            yieldSum: '70',
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: null,
        };

        const res = await getPortfolioGrainSummary(ctxFor());

        expect(res.perSeason).toHaveLength(2);
        expect(res.perSeason[res.perSeason.length - 1].seasonName).toBeNull();
        expect(res.perSeason[res.perSeason.length - 1].contractedSaleTonnes).toBe(50);
    });

    it('excludes PURCHASE contracts — coverage is about what was sold', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        TENANT_DATA['farm-a'] = {
            contracts: [
                { status: 'ACTIVE', type: 'SALE', volumeTonnes: '100', seasonId: 's-1' },
                { status: 'ACTIVE', type: 'PURCHASE', volumeTonnes: '900', seasonId: 's-1' },
            ],
            seasons: [{ id: 's-1', name: '2026 Harvest' }],
            yieldBySeason: [{ seasonId: 's-1', grossTonnes: '200' }],
            yieldSum: '200',
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: null,
        };

        const res = await getPortfolioGrainSummary(ctxFor());
        expect(res.perSeason[0].contractedSaleTonnes).toBe(100);
    });

    it('is empty when no tenant has season-linked grain', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'empty', name: 'Empty Farm', slug: 'empty' }],
        });
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
        expect(res.perSeason).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────
//  Contract value (the revenue side)
// ─────────────────────────────────────────────────────────────────────

describe('getPortfolioGrainSummary — contract value', () => {
    const base = {
        yieldSum: null,
        logCost: null,
        stockCost: null,
        bins: [],
        stored: [],
    };

    it('reports contracted value alongside activity cost', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        TENANT_DATA['farm-a'] = {
            ...base,
            currency: 'EUR',
            contracts: [
                {
                    status: 'ACTIVE',
                    type: 'SALE',
                    volumeTonnes: '500',
                    pricePerTonne: '210',
                    priceCurrency: 'EUR',
                },
            ],
        };

        const res = await getPortfolioGrainSummary(ctxFor());
        expect(res.totals.contractedValue).toBe(105000);
        expect(res.totals.mixedCurrency).toBe(false);
        expect(res.perTenant[0].contractedValue).toBe(105000);
    });

    it('excludes DRAFT and CANCELLED from the valued book', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        TENANT_DATA['farm-a'] = {
            ...base,
            currency: 'EUR',
            contracts: [
                { status: 'ACTIVE', type: 'SALE', volumeTonnes: '10', pricePerTonne: '100', priceCurrency: 'EUR' },
                { status: 'DRAFT', type: 'SALE', volumeTonnes: '999', pricePerTonne: '100', priceCurrency: 'EUR' },
                { status: 'CANCELLED', type: 'SALE', volumeTonnes: '999', pricePerTonne: '100', priceCurrency: 'EUR' },
            ],
        };
        const res = await getPortfolioGrainSummary(ctxFor());
        expect(res.totals.contractedValue).toBe(1000);
    });

    it('never blends currencies — it flags the total as partial instead', async () => {
        // €100k + $100k is not 200k of anything. The org total covers the
        // reference currency only, and says so.
        getPortfolioDataMock.mockResolvedValue({
            tenants: [
                { id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' },
                { id: 'farm-b', name: 'Bravo Farm', slug: 'bravo' },
            ],
        });
        TENANT_DATA['farm-a'] = {
            ...base,
            currency: 'EUR',
            contracts: [
                { status: 'ACTIVE', type: 'SALE', volumeTonnes: '100', pricePerTonne: '1000', priceCurrency: 'EUR' },
            ],
        };
        TENANT_DATA['farm-b'] = {
            ...base,
            currency: 'USD',
            contracts: [
                { status: 'ACTIVE', type: 'SALE', volumeTonnes: '100', pricePerTonne: '1000', priceCurrency: 'USD' },
            ],
        };

        const res = await getPortfolioGrainSummary(ctxFor());

        expect(res.totals.currency).toBe('EUR');
        expect(res.totals.contractedValue).toBe(100000); // EUR only
        expect(res.totals.mixedCurrency).toBe(true);
        // Emphatically NOT the blended 200000.
        expect(res.totals.contractedValue).not.toBe(200000);
    });

    it('reports zero value (not mixed) when nothing is priced', async () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
        TENANT_DATA['farm-a'] = {
            ...base,
            currency: null,
            contracts: [{ status: 'ACTIVE', type: 'SALE', volumeTonnes: '100' }],
        };
        const res = await getPortfolioGrainSummary(ctxFor());
        expect(res.totals.contractedValue).toBe(0);
        expect(res.totals.mixedCurrency).toBe(false);
    });
});

// ─── production vs stock: the overlap figure ────────────────────────
//
// The dashboard renders production beside on-hand stock. They measure
// different things and are not additive, so where the SAME grain appears in
// both — a journal harvest that minted its yield record — the total has to
// say how much, or a group operator reading the two tiles as one figure is
// double-counting with nothing to warn them.

describe('getPortfolioGrainSummary — yield/stock overlap', () => {
    const oneFarm = () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
    };

    it('reports how much recorded production is also in store', async () => {
        oneFarm();
        TENANT_DATA['farm-a'] = {
            yieldSum: '500',
            // 200 t of it was logged in the journal, so the same grain is
            // ALSO counted in binStoredTonnes.
            yieldFromJournalSum: '200',
            logCost: null,
            stockCost: null,
            bins: [{ id: 'bin-1', capacityTonnes: '1000' }],
            stored: [{ locationId: 'bin-1', unitId: 'unit-t', _sum: { quantityOnHand: '200' }, _count: { _all: 1 } }],
            currency: 'BGN',
        };

        const res = await getPortfolioGrainSummary(ctxFor());

        expect(res.totals.totalYieldTonnes).toBe(500);
        expect(res.totals.yieldAlsoInStoreTonnes).toBe(200);
        expect(res.perTenant[0].yieldAlsoInStoreTonnes).toBe(200);
    });

    it('reports zero overlap when every yield was typed on the yield page', async () => {
        oneFarm();
        TENANT_DATA['farm-a'] = {
            yieldSum: '500',
            yieldFromJournalSum: null,
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: 'BGN',
        };

        const res = await getPortfolioGrainSummary(ctxFor());
        expect(res.totals.totalYieldTonnes).toBe(500);
        expect(res.totals.yieldAlsoInStoreTonnes).toBe(0);
    });

    it('asks the DB for the linked subset rather than filtering in memory', async () => {
        oneFarm();
        TENANT_DATA['farm-a'] = {
            yieldSum: '10',
            yieldFromJournalSum: '4',
            logCost: null,
            stockCost: null,
            bins: [],
            stored: [],
            currency: null,
        };

        await getPortfolioGrainSummary(ctxFor());

        // Two aggregates, both real DB aggregates — the recap's take-5000
        // findMany is precisely the anti-pattern this view avoids.
        expect(yieldAggregateArgs).toHaveLength(2);
        expect(yieldAggregateArgs.some((a) => a?.where?.logEntryId?.not === null)).toBe(true);
        expect(yieldAggregateArgs.some((a) => a?.where?.logEntryId === undefined)).toBe(true);
    });
});

// ─── cost currency is not contract currency ─────────────────────────
//
// `currency` on a tenant row is the DOMINANT CONTRACT currency, and it used
// to be documented as the "cost/price" currency and applied to
// totalActivityCost too. A farm selling in EUR and buying inputs in BGN had
// its spend labelled EUR — and with no live priced contract, the label fell
// back to the OLDEST contract on record.

describe('getPortfolioGrainSummary — activity cost reports its own currency', () => {
    const oneFarm = () => {
        getPortfolioDataMock.mockResolvedValue({
            tenants: [{ id: 'farm-a', name: 'Alpha Farm', slug: 'alpha' }],
        });
    };

    it('reads cost currencies from the cost rows, not from contracts', async () => {
        oneFarm();
        TENANT_DATA['farm-a'] = {
            contracts: [{ status: 'ACTIVE', type: 'SALE', volumeTonnes: '100', pricePerTonne: '200', priceCurrency: 'EUR' }],
            yieldSum: null,
            logCost: '500',
            stockCost: '250',
            costCurrencies: ['BGN'],
            bins: [],
            stored: [],
            currency: 'EUR',
        };

        const res = await getPortfolioGrainSummary(ctxFor());
        const row = res.perTenant[0];
        // The contract currency still labels contracted value…
        expect(row.currency).toBe('EUR');
        // …while the spend says what it was actually recorded in.
        expect(row.costCurrencies).toEqual(['BGN']);
        expect(row.costCurrencyMixed).toBe(false);
    });

    it('flags activity cost recorded in more than one currency', async () => {
        oneFarm();
        TENANT_DATA['farm-a'] = {
            yieldSum: null,
            logCost: '500',
            stockCost: '250',
            costCurrencies: ['BGN', 'EUR'],
            bins: [],
            stored: [],
            currency: null,
        };

        const res = await getPortfolioGrainSummary(ctxFor());
        expect(res.perTenant[0].costCurrencyMixed).toBe(true);
        expect(res.perTenant[0].costCurrencies).toEqual(['BGN', 'EUR']);
    });
});
