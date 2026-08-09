/**
 * Route-level cross-tenant guard — the WIRE contract.
 *
 * The Exchange usecase throws forbidden/notFound on a cross-tenant write
 * (covered by exchange-usecase.test.ts). These tests drive the actual HTTP
 * handlers as a FOREIGN tenant and assert the wrapper maps those throws to
 * 403 / 404 with zero mutation — the contract a client actually sees.
 *
 * Refactored (Roadmap-5 PR4) to run through the reusable
 * `assertCrossTenantGuard` factory (tests/helpers/cross-tenant-guard.ts) — the
 * same harness every privileged route's cross-tenant test now shares.
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
    runInGlobalContext: jest.fn(async (fn: (db: any) => any) => fn(mockDb)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    withTenantDb: jest.fn(async (_id: string, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/exchange', () => ({
    ExchangeRepository: {
        getListing: jest.fn(),
        updateListingStatus: jest.fn(),
        getInquiry: jest.fn(),
        updateInquiryStatus: jest.fn(),
    },
}));

import { NextRequest } from 'next/server';
import { ExchangeRepository } from '@/app-layer/repositories/exchange';
import { PATCH as PATCH_LISTING } from '@/app/api/t/[tenantSlug]/exchange/listings/[listingId]/route';
import { PATCH as PATCH_INQUIRY } from '@/app/api/t/[tenantSlug]/exchange/inquiries/[inquiryId]/route';
import { makeRequestContext } from '../helpers/make-context';
import { assertCrossTenantGuard } from '../helpers/cross-tenant-guard';

const repo = ExchangeRepository as jest.Mocked<typeof ExchangeRepository>;

function patchReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/t/tenant-b/exchange', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    // The CALLER is always tenant-b; the rows they target are owned by tenant-a.
    getTenantCtxMock.mockResolvedValue(
        makeRequestContext('EDITOR', { tenantId: 'tenant-b', userId: 'user-b' }),
    );
});

// ── Cross-tenant guard, via the shared factory ───────────────────────────
assertCrossTenantGuard({
    name: 'PATCH /exchange/listings/[listingId]',
    handler: PATCH_LISTING,
    makeReq: () => patchReq({ action: 'WITHDRAWN' }),
    params: { tenantSlug: 'tenant-b', listingId: 'lst-1' },
    arrangeForeignRow: () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repo.getListing.mockResolvedValue({ id: 'lst-1', sellerTenantId: 'tenant-a', status: 'ACTIVE', commodity: 'Wheat' } as any),
    arrangeMissing: () => repo.getListing.mockResolvedValue(null),
    mutationSpy: () => repo.updateListingStatus,
});

assertCrossTenantGuard({
    name: 'PATCH /exchange/inquiries/[inquiryId]',
    handler: PATCH_INQUIRY,
    makeReq: () => patchReq({ action: 'ACCEPTED' }),
    params: { tenantSlug: 'tenant-b', inquiryId: 'inq-1' },
    arrangeForeignRow: () =>
        repo.getInquiry.mockResolvedValue({
            id: 'inq-1', status: 'PENDING', listing: { sellerTenantId: 'tenant-a', commodity: 'Wheat' },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
    arrangeMissing: () => repo.getInquiry.mockResolvedValue(null),
    mutationSpy: () => repo.updateInquiryStatus,
    // ONE oracle, deliberately. An inquiry is a private buyer<->seller
    // conversation, and a 403/404 split let an outsider confirm that a given
    // inquiry id EXISTS on someone else's listing, one id at a time. The
    // guard is unchanged (the mutation spy below still has to stay empty) —
    // only what a non-seller learns from the failure changed.
    foreignStatus: 404,
});

// ── Positive practice: the owner IS let through (guard isn't just deny-all) ──
describe('PATCH /exchange/listings/[listingId] — owner allowed', () => {
    it('200 when the caller OWNS the listing', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repo.getListing.mockResolvedValue({ id: 'lst-9', sellerTenantId: 'tenant-b', status: 'ACTIVE', commodity: 'Barley' } as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repo.updateListingStatus.mockResolvedValue({ id: 'lst-9', status: 'WITHDRAWN' } as any);
        const res = await PATCH_LISTING(patchReq({ action: 'WITHDRAWN' }), {
            params: Promise.resolve({ tenantSlug: 'tenant-b', listingId: 'lst-9' }),
        });
        expect(res.status).toBe(200);
        expect(repo.updateListingStatus).toHaveBeenCalledWith(mockDb, 'lst-9', 'WITHDRAWN');
    });
});
