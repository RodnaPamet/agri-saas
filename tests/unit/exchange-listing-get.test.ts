/**
 * GET /api/t/[tenantSlug]/exchange/listings/[listingId] — the deep-link fetch.
 * Returns the public projection for any tenant's listing; 404 when missing.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));
jest.mock('@/app-layer/usecases/modules', () => ({
    __esModule: true,
    assertModuleEnabled: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

const mockDb = {} as Record<string, unknown>;
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    withTenantDb: jest.fn(async (_id: string, fn: (db: any) => any) => fn(mockDb)),
}));

// P1.7 — the RLS-free read of "which tenants switched EXCHANGE off" moved from
// the untyped `runInGlobalContext` to `runWithoutRls({ reason })`. Mocked here
// so the stub also asserts the REASON: a bypass that silently changed its
// stated justification would otherwise pass.
// SPREAD, not replaced. A whole-module double of this barrel omits
// `withRlsTripwireExtension`, which `src/lib/prisma.ts` calls at module load —
// and `@/lib/errors/api` reaches that module since #1655 put the deletion
// freeze at the mutation choke point. The symptom was
// `withRlsTripwireExtension is not a function`: a suite-level failure to run
// before the freeze was made a lazy import, and a 500 instead of a 404 after.
// The repo's partial-barrel-mock trap, and the mock was a landmine for whoever
// next widened this module's graph.
jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    __esModule: true,
    runWithoutRls: jest.fn(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (opts: { reason: string }, fn: (db: any) => any) => {
            // TWO legitimate bypasses reach this usecase now, so the
            // assertion is an allowlist rather than a single value — a bypass
            // that silently changed its stated justification must still fail,
            // which is the whole reason this mock asserts the reason at all.
            //
            //   module-availability        — which sellers switched EXCHANGE off
            //   exchange-farm-attribution  — which sellers are published farms (P6.7)
            expect(['module-availability', 'exchange-farm-attribution']).toContain(opts.reason);
            return fn(mockDb);
        },
    ),
}));
jest.mock('@/app-layer/repositories/exchange', () => ({
    ExchangeRepository: {
        getListing: jest.fn(),
        // A deep link must honour the same seller-module exclusion the feed
        // does; default to "nobody opted out".
        listTenantIdsWithModuleDisabled: jest.fn().mockResolvedValue([]),
        // P6.7 — resolves which sellers are published farms. Defaults to
        // NONE, so every existing assertion in this file keeps seeing the
        // typed `sellerDisplayName` and nothing is attributed by accident.
        listPublishedFarmBrands: jest.fn().mockResolvedValue([]),
    },
}));

import { NextRequest } from 'next/server';
import { ExchangeRepository } from '@/app-layer/repositories/exchange';
import { GET } from '@/app/api/t/[tenantSlug]/exchange/listings/[listingId]/route';
import { makeRequestContext } from '../helpers/make-context';

const repo = ExchangeRepository as jest.Mocked<typeof ExchangeRepository>;

function getReq(): NextRequest {
    return new NextRequest('http://localhost/api/t/viewer/exchange/listings/lst-1', { method: 'GET' });
}

beforeEach(() => {
    jest.clearAllMocks();
    repo.listTenantIdsWithModuleDisabled.mockResolvedValue([] as never);
    getTenantCtxMock.mockResolvedValue(makeRequestContext('EDITOR', { tenantId: 'viewer-t', userId: 'u' }));
});

it('returns the public projection (200) with viewer-derived isOwn', async () => {
    repo.getListing.mockResolvedValue({
        id: 'lst-1', sellerTenantId: 'seller-t', sellerUserId: 's', side: 'SELL',
        commodity: 'Wheat', quantityTonnes: 100, pricePerTonne: null, priceCurrency: 'BGN',
        regionCode: 'BG-16', regionName: 'Plovdiv', lat: 42, lon: 24, description: null,
        sellerDisplayName: null, status: 'ACTIVE', createdAt: new Date('2026-07-01'), expiresAt: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await GET(getReq(), { params: Promise.resolve({ tenantSlug: 'viewer', listingId: 'lst-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: 'lst-1', commodity: 'Wheat', isOwn: false, quantityTonnes: '100' });
    // The private owning-tenant id is never projected.
    expect(body.sellerTenantId).toBeUndefined();
});

it('returns 404 for a missing listing', async () => {
    repo.getListing.mockResolvedValue(null);
    const res = await GET(getReq(), { params: Promise.resolve({ tenantSlug: 'viewer', listingId: 'nope' }) });
    expect(res.status).toBe(404);
});
