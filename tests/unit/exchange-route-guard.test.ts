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
            // An ALLOWLIST rather than one value, which is what the sibling
            // suite already moved to for the same cause. TWO legitimate
            // bypasses reach this route now: the edit's RESPONSE runs
            // `withFarmAttribution`, so a second reason appears on a path
            // that previously only needed module availability. A bypass
            // that silently changed its stated justification must still
            // fail, which is the whole reason the mock asserts it.
            expect(['module-availability', 'exchange-farm-attribution']).toContain(opts.reason);
            return fn(mockDb);
        },
    ),
}));

jest.mock('@/app-layer/repositories/exchange', () => ({
    ExchangeRepository: {
        getListing: jest.fn(),
        updateListingStatus: jest.fn(),
        updateListingFields: jest.fn(),
        getInquiry: jest.fn(),
        updateInquiryStatus: jest.fn(),
        // `withFarmAttribution` runs on the edit's RESPONSE, and a partial
        // barrel mock leaves an unlisted method undefined rather than falling
        // through — the trap this file's own notes describe twice.
        listPublishedFarmBrands: jest.fn().mockResolvedValue([]),
    },
}));

// Only consulted on a REACTIVATION, but a partial mock has to carry both or
// the call site throws instead of being skipped.
jest.mock('@/lib/billing/entitlements', () => ({
    assertWithinLimit: jest.fn().mockResolvedValue(undefined),
    assertNotPastDueRestricted: jest.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from 'next/server';
import { ExchangeRepository } from '@/app-layer/repositories/exchange';
import {
    PATCH as PATCH_LISTING,
    PUT as PUT_LISTING,
} from '@/app/api/t/[tenantSlug]/exchange/listings/[listingId]/route';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { PATCH as PATCH_INQUIRY } from '@/app/api/t/[tenantSlug]/exchange/inquiries/[inquiryId]/route';
import { makeRequestContext } from '../helpers/make-context';
import { assertCrossTenantGuard } from '../helpers/cross-tenant-guard';

const repo = ExchangeRepository as jest.Mocked<typeof ExchangeRepository>;

/** The row shape `getListing` resolves, named so the fixtures below need no
 *  `any`: they are deliberately PARTIAL rows, which is what the double step
 *  through `unknown` says. `as any` would say something weaker and cost a
 *  line of the shared suppression ceiling. */
type ListingRow = NonNullable<Awaited<ReturnType<typeof ExchangeRepository.getListing>>>;

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

// ── The EDIT route — #2543 ───────────────────────────────────────────────

const assertModuleEnabledMock = assertModuleEnabled as jest.MockedFunction<typeof assertModuleEnabled>;

/** A complete body: the edit is a FULL replacement, so nothing is partial. */
function editBody(over: Record<string, unknown> = {}) {
    return {
        side: 'SELL',
        kind: 'CULTURE',
        commodity: 'Barley',
        quantityTonnes: 25,
        pricePerTonne: 180,
        priceCurrency: 'EUR',
        regionCode: 'BG-16',
        description: null,
        sellerDisplayName: null,
        publishAsFarm: false,
        sellerContact: null,
        expiresAt: null,
        updatedAt: '2026-10-31T12:00:00.000Z',
        ...over,
    };
}

function putReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/t/tenant-b/exchange', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const OWNED = {
    id: 'lst-9',
    sellerTenantId: 'tenant-b',
    status: 'ACTIVE',
    commodity: 'Barley',
    side: 'SELL',
    kind: 'CULTURE',
    quantityTonnes: 25,
    pricePerTonne: 180,
    priceCurrency: 'EUR',
    regionCode: 'BG-16',
    regionName: 'Plovdiv',
    lat: 42,
    lon: 24.7,
    description: null,
    sellerDisplayName: null,
    publishAsFarm: false,
    sellerContact: null,
    expiresAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-31T12:00:00.000Z'),
} as unknown as ListingRow;

assertCrossTenantGuard({
    name: 'PUT /exchange/listings/[listingId]',
    handler: PUT_LISTING,
    makeReq: () => putReq(editBody()),
    params: { tenantSlug: 'tenant-b', listingId: 'lst-1' },
    arrangeForeignRow: () =>
        repo.getListing.mockResolvedValue({ ...OWNED, id: 'lst-1', sellerTenantId: 'tenant-a' }),
    arrangeMissing: () => repo.getListing.mockResolvedValue(null),
    mutationSpy: () => repo.updateListingFields,
});

describe('PUT /exchange/listings/[listingId] — the module gate, and the response', () => {
    beforeEach(() => {
        repo.getListing.mockResolvedValue(OWNED);
        repo.updateListingFields.mockImplementation(
            async (_db, _id, data) => ({ ...OWNED, ...data }) as unknown as ListingRow,
        );
    });

    it('200 for the owner, and the response carries `edit`', async () => {
        const res = await PUT_LISTING(putReq(editBody()), {
            params: Promise.resolve({ tenantSlug: 'tenant-b', listingId: 'lst-9' }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        // `edit` is this endpoint's own request shape, so a client can
        // repopulate the form from the answer without a second read — and a
        // round-trip is a no-op by construction rather than by convention.
        expect(json.edit).toBeDefined();
        expect(json.edit.updatedAt).toBeDefined();
        expect(Object.keys(json.edit).sort()).toEqual(
            Object.keys(editBody()).sort(),
        );
    });

    it('REQUIRES the EXCHANGE module — unlike withdraw, which is exempt', async () => {
        /*
         * The asymmetry is the design, not an oversight. `withdrawListing` is
         * deliberately exempt because the module toggle governs PARTICIPATION
         * in the marketplace rather than CUSTODY of rows you already posted —
         * gating withdraw once left a tenant with public listings and no
         * endpoint that could take them down. Editing changes what is being
         * OFFERED to buyers, so it gates like fulfil.
         *
         * Asserted as a COMPARISON, because "the edit calls the gate" alone
         * would still pass if somebody later gated withdraw too, and that
         * would be the regression the exemption exists to prevent.
         */
        assertModuleEnabledMock.mockClear();
        await PUT_LISTING(putReq(editBody()), {
            params: Promise.resolve({ tenantSlug: 'tenant-b', listingId: 'lst-9' }),
        });
        const editGated = assertModuleEnabledMock.mock.calls.length;

        assertModuleEnabledMock.mockClear();
        repo.updateListingStatus.mockResolvedValue({ id: 'lst-9', status: 'WITHDRAWN' } as unknown as ListingRow);
        await PATCH_LISTING(patchReq({ action: 'WITHDRAWN' }), {
            params: Promise.resolve({ tenantSlug: 'tenant-b', listingId: 'lst-9' }),
        });
        const withdrawGated = assertModuleEnabledMock.mock.calls.length;

        expect(editGated).toBeGreaterThan(0);
        expect(withdrawGated).toBe(0);
    });

    it('refuses a body missing the precondition, before touching the row', async () => {
        const body = editBody();
        delete (body as Record<string, unknown>).updatedAt;

        const res = await PUT_LISTING(putReq(body), {
            params: Promise.resolve({ tenantSlug: 'tenant-b', listingId: 'lst-9' }),
        });

        expect(res.status).toBe(400);
        expect(repo.updateListingFields).not.toHaveBeenCalled();
    });
});
