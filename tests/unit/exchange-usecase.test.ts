/**
 * Unit tests — Exchange usecase cross-tenant guards + global reads.
 *
 * The Exchange tables are GLOBAL (no RLS), so the usecase layer is the sole
 * cross-tenant safety boundary. These tests lock the invariants:
 *   - editing (withdraw/fulfil) ANOTHER tenant's listing throws forbidden;
 *   - inquiring on your OWN listing throws forbidden;
 *   - listActiveListings returns rows across tenants (the read is global,
 *     NOT tenant-filtered).
 *
 * Prisma + repository + audit are mocked (no DB); `runInTenantContext` is a
 * passthrough that hands a stub `db` to the usecase callback.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDb = {} as any;
// The seller-tenant db handle handed to withTenantDb — the seller-context
// membership READ and the notification WRITE both flow through it (both are
// RLS-forced tables under the seller's tenant, not the inquirer's).
const notificationCreateMany = jest.fn();
const membershipFindMany = jest.fn();
const mockSellerDb = {
    tenantMembership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    notification: { createMany: notificationCreateMany },
};
// Captures the tenantId withTenantDb was bound to (must be the SELLER's).
const withTenantDbCalls: string[] = [];

jest.mock('@/lib/db-context', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    withTenantDb: jest.fn(async (tenantId: string, fn: (db: any) => any) => {
        withTenantDbCalls.push(tenantId);
        return fn(mockSellerDb);
    }),
}));

// P1.7 — the RLS-free read of "which tenants switched EXCHANGE off" moved from
// the untyped `runInGlobalContext` to `runWithoutRls({ reason })`. Mocked here
// so the stub also asserts the REASON: a bypass that silently changed its
// stated justification would otherwise pass.
jest.mock('@/lib/db/rls-middleware', () => ({
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
        listActiveListings: jest.fn(),
        listTenantIdsWithModuleDisabled: jest.fn().mockResolvedValue([]),
        // P6.7 — resolves which sellers are published farms. Defaults to
        // NONE, so every existing assertion in this file keeps seeing the
        // typed `sellerDisplayName` and nothing is attributed by accident.
        listPublishedFarmBrands: jest.fn().mockResolvedValue([]),
        getListing: jest.fn(),
        createListing: jest.fn(),
        updateListingStatus: jest.fn(),
        createInquiry: jest.fn(),
        listInquiriesByInquirer: jest.fn(),
        getInquiry: jest.fn(),
        updateInquiryStatus: jest.fn(),
        declinePendingInquiries: jest.fn(),
        listListingsBySeller: jest.fn(),
        updateListingFields: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

// Keep sanitize a passthrough — the sanitiser has its own tests; here we
// only care that free text flows through it (identity is enough).
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (s: string | null | undefined) => (s == null ? '' : s),
    // `sanitizeOptional` arrived in this mock with #2543's edit path, which
    // calls both. The note on the entitlements mock below says why that
    // matters: a PARTIAL mock of a shared barrel leaves an unlisted function
    // undefined, so the call site throws "is not a function" rather than
    // falling through to the real module.
    sanitizeOptional: (s: string | null | undefined) => (s == null ? null : s),
}));

const sendInquiryEmail = jest.fn();
jest.mock('@/lib/email/inquiry-email', () => ({
    sendInquiryEmail: (...a: unknown[]) => sendInquiryEmail(...a),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// Entitlements: assertWithinLimit is a no-op by default so createListing's
// quota gate doesn't need a billing DB stub; the quota test overrides it.
// A PARTIAL mock of a shared barrel, so every function the usecase calls has
// to be listed — a missing one throws "is not a function" at the call site
// rather than falling through to the real module. `assertNotPastDueRestricted`
// arrived with #1325 and this is the suite that found that out.
jest.mock('@/lib/billing/entitlements', () => ({
    assertWithinLimit: jest.fn().mockResolvedValue(undefined),
    assertNotPastDueRestricted: jest.fn().mockResolvedValue(undefined),
}));

import { ExchangeRepository } from '@/app-layer/repositories/exchange';
import {
    listActiveListings,
    createListing,
    withdrawListing,
    fulfillListing,
    createInquiry,
    respondToInquiry,
    updateListingFields,
} from '@/app-layer/usecases/exchange';
import { assertWithinLimit } from '@/lib/billing/entitlements';
import type { UpdateListingBody } from '@/app-layer/schemas/exchange.schemas';
import { forbidden } from '@/lib/errors/types';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRequestContext } from '../helpers/make-context';

const assertWithinLimitMock = assertWithinLimit as jest.MockedFunction<typeof assertWithinLimit>;

const repo = ExchangeRepository as jest.Mocked<typeof ExchangeRepository>;

// Two different tenants.
const meCtx = makeRequestContext('EDITOR', { tenantId: 'tenant-1', userId: 'user-1' });
const otherTenantId = 'tenant-2';

function listing(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: 'lst-1',
        sellerTenantId: 'tenant-1',
        sellerUserId: 'user-1',
        side: 'SELL',
        commodity: 'Wheat',
        status: 'ACTIVE',
        regionCode: 'BG-16',
        ...overrides,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

beforeEach(() => {
    jest.clearAllMocks();
    withTenantDbCalls.length = 0;
    membershipFindMany.mockResolvedValue([]);
    sendInquiryEmail.mockResolvedValue({ sent: true });
    notificationCreateMany.mockResolvedValue({ count: 0 });
    repo.declinePendingInquiries.mockResolvedValue([]);
});

describe('cross-tenant write guard', () => {
    it('withdrawListing on ANOTHER tenant’s listing throws forbidden', async () => {
        repo.getListing.mockResolvedValue(listing({ sellerTenantId: otherTenantId }));
        await expect(withdrawListing(meCtx, 'lst-1')).rejects.toMatchObject({ code: 'LISTING_NOT_OWNED' });
        expect(repo.updateListingStatus).not.toHaveBeenCalled();
    });

    it('fulfillListing on ANOTHER tenant’s listing throws forbidden', async () => {
        repo.getListing.mockResolvedValue(listing({ sellerTenantId: otherTenantId }));
        await expect(fulfillListing(meCtx, 'lst-1')).rejects.toMatchObject({ code: 'LISTING_NOT_OWNED' });
        expect(repo.updateListingStatus).not.toHaveBeenCalled();
    });

    it('withdrawListing on your OWN listing succeeds + flips status to WITHDRAWN', async () => {
        repo.getListing.mockResolvedValue(listing({ sellerTenantId: 'tenant-1' }));
        repo.updateListingStatus.mockResolvedValue(listing({ status: 'WITHDRAWN' }));
        await withdrawListing(meCtx, 'lst-1');
        expect(repo.updateListingStatus).toHaveBeenCalledWith(mockDb, 'lst-1', 'WITHDRAWN');
    });

    it('withdrawListing on a missing listing throws notFound', async () => {
        repo.getListing.mockResolvedValue(null);
        await expect(withdrawListing(meCtx, 'nope')).rejects.toThrow(/not found/i);
    });
});

describe('createInquiry guards', () => {
    it('inquiring on your OWN listing throws forbidden', async () => {
        repo.getListing.mockResolvedValue(listing({ sellerTenantId: 'tenant-1', status: 'ACTIVE' }));
        await expect(
            createInquiry(meCtx, { listingId: 'lst-1', message: 'interested' }),
        ).rejects.toMatchObject({ code: 'LISTING_IS_YOUR_OWN' });
        expect(repo.createInquiry).not.toHaveBeenCalled();
    });

    it('inquiring on a non-ACTIVE listing throws badRequest', async () => {
        repo.getListing.mockResolvedValue(listing({ sellerTenantId: otherTenantId, status: 'FULFILLED' }));
        await expect(
            createInquiry(meCtx, { listingId: 'lst-1', message: 'interested' }),
        ).rejects.toMatchObject({ code: 'LISTING_NOT_ACTIVE' });
        expect(repo.createInquiry).not.toHaveBeenCalled();
    });

    it('inquiring on ANOTHER tenant’s ACTIVE listing succeeds', async () => {
        repo.getListing.mockResolvedValue(listing({ sellerTenantId: otherTenantId, status: 'ACTIVE' }));
        repo.createInquiry.mockResolvedValue({ id: 'inq-1' } as never);
        await createInquiry(meCtx, { listingId: 'lst-1', message: 'interested' });
        expect(repo.createInquiry).toHaveBeenCalledWith(
            mockDb,
            expect.objectContaining({
                listingId: 'lst-1',
                inquirerTenantId: 'tenant-1',
                inquirerUserId: 'user-1',
            }),
        );
    });

    it('a duplicate inquiry (P2002 unique violation) surfaces a friendly conflict', async () => {
        repo.getListing.mockResolvedValue(listing({ sellerTenantId: otherTenantId, status: 'ACTIVE' }));
        repo.createInquiry.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
                code: 'P2002',
                clientVersion: '7.8.0',
            }),
        );
        await expect(
            createInquiry(meCtx, { listingId: 'lst-1', message: 'again' }),
        ).rejects.toThrow(/already expressed interest/i);
    });
});

describe('createListing', () => {
    it('rejects an unknown region code with badRequest', async () => {
        await expect(
            createListing(meCtx, {
                side: 'SELL',
                kind: 'CULTURE',
                commodity: 'Wheat',
                quantityTonnes: 10,
                regionCode: 'BG-99',
            }),
        ).rejects.toThrow(/region/i);
        expect(repo.createListing).not.toHaveBeenCalled();
    });

    it('fixes ownership to the caller tenant + derives region from the code', async () => {
        repo.createListing.mockResolvedValue(listing() as never);
        await createListing(meCtx, {
            side: 'SELL',
            kind: 'CULTURE',
            commodity: 'Wheat',
            quantityTonnes: 10,
            regionCode: 'BG-16',
        });
        expect(repo.createListing).toHaveBeenCalledWith(
            mockDb,
            expect.objectContaining({
                sellerTenantId: 'tenant-1',
                sellerUserId: 'user-1',
                regionCode: 'BG-16',
                regionName: 'Plovdiv',
                // Euro-denominated by construction: the usecase stamps the
                // marketplace currency, so a create cannot introduce a second
                // one however the caller was written.
                priceCurrency: 'EUR',
            }),
        );
    });

    it('enforces the per-tenant ACTIVE-listing quota (plan_limit_exceeded)', async () => {
        assertWithinLimitMock.mockRejectedValueOnce(
            forbidden('plan_limit_exceeded: FREE plan allows 5 exchange_listing(s); tenant currently has 5.'),
        );
        await expect(
            createListing(meCtx, { side: 'SELL', kind: 'CULTURE', commodity: 'Wheat', quantityTonnes: 10, regionCode: 'BG-16' }),
        ).rejects.toThrow(/plan_limit_exceeded/);
        // Third argument = the create's OWN transaction. The check and the
        // insert now share one, so two concurrent creates on a tenant at
        // limit-1 cannot both read limit-1 and both write.
        expect(assertWithinLimitMock).toHaveBeenCalledWith(meCtx, 'exchange_listing', mockDb);
        expect(repo.createListing).not.toHaveBeenCalled();
    });
});

describe('createInquiry seller fanout (notify + email, fail-open)', () => {
    const activeListing = { sellerTenantId: 'tenant-2', status: 'ACTIVE', commodity: 'Wheat', side: 'SELL' };

    it('writes the Notification in the SELLER tenant (withTenantDb) + emails its admins', async () => {
        repo.getListing.mockResolvedValue(listing({ ...activeListing }));
        repo.createInquiry.mockResolvedValue({ id: 'inq-1', quantityTonnes: null } as never);
        membershipFindMany.mockResolvedValue([
            { userId: 'seller-admin-1', user: { email: 'a1@seller.test' }, tenant: { slug: 'seller' } },
            { userId: 'seller-admin-2', user: { email: 'a2@seller.test' }, tenant: { slug: 'seller' } },
        ]);

        await createInquiry(meCtx, { listingId: 'lst-1', message: 'want 100t' });

        // Notification is bound to the SELLER's tenant (tenant-2), NOT the
        // inquirer's (tenant-1) — RLS would reject it otherwise.
        expect(withTenantDbCalls).toEqual(['tenant-2']);
        expect(notificationCreateMany).toHaveBeenCalledTimes(1);
        const notifArg = notificationCreateMany.mock.calls[0][0] as { data: Array<Record<string, unknown>> };
        expect(notifArg.data).toHaveLength(2);
        expect(notifArg.data[0]).toMatchObject({ tenantId: 'tenant-2', userId: 'seller-admin-1' });
        // Both seller admins emailed.
        expect(sendInquiryEmail).toHaveBeenCalledTimes(2);
        expect(sendInquiryEmail).toHaveBeenCalledWith(
            expect.objectContaining({ to: 'a1@seller.test', commodity: 'Wheat' }),
        );
    });

    it('is fail-open — an email failure does NOT reject the committed inquiry', async () => {
        repo.getListing.mockResolvedValue(listing({ ...activeListing }));
        repo.createInquiry.mockResolvedValue({ id: 'inq-1', quantityTonnes: null } as never);
        membershipFindMany.mockResolvedValue([{ userId: 's1', user: { email: 'a@s.test' }, tenant: { slug: 'seller' } }]);
        sendInquiryEmail.mockRejectedValue(new Error('smtp down'));

        const inquiry = await createInquiry(meCtx, { listingId: 'lst-1', message: 'hi' });
        expect(inquiry).toEqual({ id: 'inq-1', quantityTonnes: null });
    });

    it('bounds the admin query to 25 and dedupes recipients by email', async () => {
        repo.getListing.mockResolvedValue(listing({ ...activeListing }));
        repo.createInquiry.mockResolvedValue({ id: 'inq-1', quantityTonnes: null } as never);
        // One email held by two admin memberships → emailed ONCE; plus a second
        // distinct admin → 2 distinct sends from 3 memberships.
        membershipFindMany.mockResolvedValue([
            { userId: 'a', user: { email: 'dup@seller.test' }, tenant: { slug: 'seller' } },
            { userId: 'b', user: { email: 'dup@seller.test' }, tenant: { slug: 'seller' } },
            { userId: 'c', user: { email: 'other@seller.test' }, tenant: { slug: 'seller' } },
        ]);

        await createInquiry(meCtx, { listingId: 'lst-1', message: 'want 100t' });

        // Bounded fanout — the membership read caps at 25 (was 5000).
        expect(membershipFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }));
        // Deduped — 3 memberships, 2 distinct emails → 2 sends.
        expect(sendInquiryEmail).toHaveBeenCalledTimes(2);
        const sentTo = sendInquiryEmail.mock.calls.map((c) => (c[0] as { to: string }).to).sort();
        expect(sentTo).toEqual(['dup@seller.test', 'other@seller.test']);
    });
});

describe('respondToInquiry (seller-only)', () => {
    const inq = (over: Record<string, unknown> = {}) => ({
        id: 'inq-1',
        status: 'PENDING',
        inquirerTenantId: 'tenant-7',
        listing: {
            id: 'lst-1',
            sellerTenantId: 'tenant-1',
            commodity: 'Wheat',
            side: 'SELL',
            status: 'ACTIVE',
            sellerContact: '+359 88 000 0000',
        },
        ...over,
    });

    it('the SELLER can accept a PENDING inquiry, and the consent stamp rides the SAME update', async () => {
        repo.getInquiry.mockResolvedValue(inq() as never);
        repo.updateInquiryStatus.mockResolvedValue({ id: 'inq-1', status: 'ACCEPTED' } as never);
        await respondToInquiry(meCtx, 'inq-1', 'ACCEPTED');
        expect(repo.updateInquiryStatus).toHaveBeenCalledWith(
            mockDb, 'inq-1', 'ACCEPTED', expect.any(Date),
        );
    });

    it('a DECLINE writes a NULL consent stamp — a refusal never shares anything', async () => {
        repo.getInquiry.mockResolvedValue(inq() as never);
        repo.updateInquiryStatus.mockResolvedValue({ id: 'inq-1', status: 'DECLINED' } as never);
        await respondToInquiry(meCtx, 'inq-1', 'DECLINED');
        expect(repo.updateInquiryStatus).toHaveBeenCalledWith(mockDb, 'inq-1', 'DECLINED', null);
    });

    // ONE oracle. A non-seller gets exactly what someone probing a random id
    // gets — "not found" — so the pair (403 = exists, 404 = doesn't) can no
    // longer be used to enumerate other tenants' private conversations. The
    // guard itself is unchanged: the mutation still never runs.
    it('a NON-seller cannot respond → notFound, indistinguishable from a missing row', async () => {
        // On the CODE and STATUS, not the prose. The sentence is displayed
        // copy and now comes from the catalogue (#1712), so a `/inquiry not
        // found/i` pattern pinned the half that is expected to change — it
        // went red on "That inquiry was not found." being reworded, while the
        // security property it exists to prove was untouched.
        //
        // That property is the point of the case: ONE oracle for "not yours"
        // and "not there", so a non-seller cannot confirm another tenant's
        // private conversation by enumerating ids. Asserting both branches
        // produce the IDENTICAL code is a stronger statement of it than two
        // regex matches were.
        repo.getInquiry.mockResolvedValue(inq({ listing: { sellerTenantId: 'tenant-9', commodity: 'Wheat', status: 'ACTIVE' } }) as never);
        const notSeller = await respondToInquiry(meCtx, 'inq-1', 'DECLINED').catch((e: unknown) => e);
        expect(notSeller).toMatchObject({ code: 'INQUIRY_NOT_FOUND', status: 404 });
        expect(repo.updateInquiryStatus).not.toHaveBeenCalled();

        // …and a genuinely missing inquiry throws the SAME code and status.
        repo.getInquiry.mockResolvedValue(null as never);
        const missing = await respondToInquiry(meCtx, 'inq-1', 'DECLINED').catch((e: unknown) => e);
        expect(missing).toMatchObject({ code: 'INQUIRY_NOT_FOUND', status: 404 });
        // Indistinguishable, stated as an equality rather than implied by two
        // assertions that happen to match the same pattern.
        expect((missing as { message: string }).message).toBe(
            (notSeller as { message: string }).message,
        );
    });

    it('an already-answered inquiry → badRequest', async () => {
        repo.getInquiry.mockResolvedValue(inq({ status: 'ACCEPTED' }) as never);
        await expect(respondToInquiry(meCtx, 'inq-1', 'DECLINED')).rejects.toMatchObject({ code: 'INQUIRY_NOT_PENDING' });
    });

    // ── Accepting is gated on the LISTING, not just the inquiry ──────────
    // An accept reveals both parties' contacts for a deal that can still
    // happen. Once the listing has left ACTIVE it cannot, so the accept is
    // refused — while the decline stays open so a seller who sold elsewhere
    // can close out the queue they left hanging.
    it.each(['FULFILLED', 'WITHDRAWN', 'EXPIRED'])(
        'refuses ACCEPT on a %s listing (no contact may be revealed)',
        async (status) => {
            repo.getInquiry.mockResolvedValue(inq({ listing: { ...inq().listing, status } }) as never);
            await expect(respondToInquiry(meCtx, 'inq-1', 'ACCEPTED')).rejects.toMatchObject({ code: 'INQUIRY_ACCEPT_REQUIRES_ACTIVE_LISTING' });
            expect(repo.updateInquiryStatus).not.toHaveBeenCalled();
        },
    );

    it('still allows DECLINE on a non-ACTIVE listing', async () => {
        repo.getInquiry.mockResolvedValue(inq({ listing: { ...inq().listing, status: 'FULFILLED' } }) as never);
        repo.updateInquiryStatus.mockResolvedValue({ id: 'inq-1', status: 'DECLINED' } as never);
        await respondToInquiry(meCtx, 'inq-1', 'DECLINED');
        expect(repo.updateInquiryStatus).toHaveBeenCalledWith(mockDb, 'inq-1', 'DECLINED', null);
    });

    it('notifies the BUYER on accept — in the BUYER’s tenant context, contact in the body', async () => {
        repo.getInquiry.mockResolvedValue(inq() as never);
        repo.updateInquiryStatus.mockResolvedValue({ id: 'inq-1', status: 'ACCEPTED' } as never);
        membershipFindMany.mockResolvedValue([{ userId: 'buyer-admin', tenant: { slug: 'buyer' } }]);

        await respondToInquiry(meCtx, 'inq-1', 'ACCEPTED');

        expect(withTenantDbCalls).toEqual(['tenant-7']);
        const notif = notificationCreateMany.mock.calls[0][0] as { data: Array<Record<string, unknown>> };
        expect(notif.data[0]).toMatchObject({ tenantId: 'tenant-7', userId: 'buyer-admin' });
        expect(String(notif.data[0].message)).toContain('+359 88 000 0000');
    });

    it('notifies the BUYER on decline too — WITHOUT any contact', async () => {
        repo.getInquiry.mockResolvedValue(inq() as never);
        repo.updateInquiryStatus.mockResolvedValue({ id: 'inq-1', status: 'DECLINED' } as never);
        membershipFindMany.mockResolvedValue([{ userId: 'buyer-admin', tenant: { slug: 'buyer' } }]);

        await respondToInquiry(meCtx, 'inq-1', 'DECLINED');

        const notif = notificationCreateMany.mock.calls[0][0] as { data: Array<Record<string, unknown>> };
        expect(String(notif.data[0].message)).not.toContain('+359 88 000 0000');
        expect(String(notif.data[0].message)).toMatch(/declined/i);
    });

    it('is fail-open — a buyer-notification failure does NOT undo the committed response', async () => {
        repo.getInquiry.mockResolvedValue(inq() as never);
        repo.updateInquiryStatus.mockResolvedValue({ id: 'inq-1', status: 'ACCEPTED' } as never);
        membershipFindMany.mockRejectedValue(new Error('db gone'));

        await expect(respondToInquiry(meCtx, 'inq-1', 'ACCEPTED')).resolves.toMatchObject({
            id: 'inq-1', status: 'ACCEPTED',
        });
    });
});

/*
 * These assertions moved from the MESSAGE to the `code` in #2543, and the move
 * is the point rather than a mechanical update. They read
 * `rejects.toThrow(/listing_terminal/i)` — which passed because
 * `badRequest(code, prose)` put the code string in the field a client RENDERS,
 * leaving `code` as a generic BAD_REQUEST for every refusal on the route. So
 * the tests were pinning the defect as the contract, and a farmer was shown
 * the literal string `listing_terminal`. See #2541.
 */
describe('listing state machine (FULFILLED / WITHDRAWN are terminal)', () => {
    it.each(['FULFILLED', 'WITHDRAWN'])(
        'refuses to withdraw an already-%s listing',
        async (status) => {
            repo.getListing.mockResolvedValue(listing({ status }));
            await expect(withdrawListing(meCtx, 'lst-1')).rejects.toMatchObject({ code: 'LISTING_TERMINAL' });
            expect(repo.updateListingStatus).not.toHaveBeenCalled();
        },
    );

    it.each(['FULFILLED', 'WITHDRAWN'])(
        'refuses to fulfil an already-%s listing (closes the FULFILLED→WITHDRAWN→FULFILLED loop)',
        async (status) => {
            repo.getListing.mockResolvedValue(listing({ status }));
            await expect(fulfillListing(meCtx, 'lst-1')).rejects.toMatchObject({ code: 'LISTING_TERMINAL' });
            expect(repo.updateListingStatus).not.toHaveBeenCalled();
        },
    );

    it('refuses EXPIRED → FULFILLED — a lapsed listing is no evidence of a sale', async () => {
        repo.getListing.mockResolvedValue(listing({ status: 'EXPIRED' }));
        await expect(fulfillListing(meCtx, 'lst-1')).rejects.toMatchObject({ code: 'LISTING_FULFIL_REQUIRES_ACTIVE' });
        expect(repo.updateListingStatus).not.toHaveBeenCalled();
    });

    it('ALLOWS EXPIRED → WITHDRAWN — tidying a lapsed listing is housekeeping', async () => {
        repo.getListing.mockResolvedValue(listing({ status: 'EXPIRED' }));
        repo.updateListingStatus.mockResolvedValue(listing({ status: 'WITHDRAWN' }));
        await withdrawListing(meCtx, 'lst-1');
        expect(repo.updateListingStatus).toHaveBeenCalledWith(mockDb, 'lst-1', 'WITHDRAWN');
    });

    it('fulfilling DECLINES the inquiries it strands and notifies each buyer', async () => {
        repo.getListing.mockResolvedValue(listing({ status: 'ACTIVE' }));
        repo.updateListingStatus.mockResolvedValue(listing({ status: 'FULFILLED' }));
        repo.declinePendingInquiries.mockResolvedValue([
            { id: 'inq-a', inquirerTenantId: 'tenant-7' },
            { id: 'inq-b', inquirerTenantId: 'tenant-8' },
        ] as never);
        membershipFindMany.mockResolvedValue([{ userId: 'buyer-admin', tenant: { slug: 'buyer' } }]);

        await fulfillListing(meCtx, 'lst-1');

        expect(repo.declinePendingInquiries).toHaveBeenCalledWith(mockDb, 'lst-1');
        // Each stranded buyer is told, in their OWN tenant context.
        expect(withTenantDbCalls).toEqual(['tenant-7', 'tenant-8']);
        // …and no contact rides along on that path.
        for (const call of notificationCreateMany.mock.calls) {
            const arg = call[0] as { data: Array<Record<string, unknown>> };
            expect(String(arg.data[0].message)).not.toMatch(/contact them on/i);
        }
    });
});

describe('listActiveListings is a GLOBAL read', () => {
    it('returns rows from OTHER tenants (not filtered by ctx.tenantId)', async () => {
        const crossTenantRows = [
            listing({ id: 'a', sellerTenantId: 'tenant-1' }),
            listing({ id: 'b', sellerTenantId: 'tenant-2' }),
            listing({ id: 'c', sellerTenantId: 'tenant-3' }),
        ];
        repo.listTenantIdsWithModuleDisabled.mockResolvedValue([] as never);
        repo.listActiveListings.mockResolvedValue({
            rows: crossTenantRows,
            nextCursor: null,
        } as never);

        const result = await listActiveListings(meCtx, {});

        // The usecase passes the caller's filters straight through and never
        // injects a tenantId — so a tenant-1 caller sees tenant-2/3 rows.
        expect(result.rows).toHaveLength(3);
        const sellers = new Set(result.rows.map((r) => r.sellerTenantId));
        expect(sellers).toEqual(new Set(['tenant-1', 'tenant-2', 'tenant-3']));
        // Repository was called with the db + filters + page — no tenant arg.
        expect(repo.listActiveListings).toHaveBeenCalledWith(
            mockDb,
            { excludeSellerTenantIds: [] },
            {},
        );
    });

    it('EXCLUDES listings whose seller switched the EXCHANGE module off', async () => {
        repo.listTenantIdsWithModuleDisabled.mockResolvedValue(['tenant-2'] as never);
        repo.listActiveListings.mockResolvedValue({ rows: [], nextCursor: null } as never);

        await listActiveListings(meCtx, {});

        // The opt-out list is read RLS-FREE (TenantModuleSettings is
        // tenant-scoped, so the viewer's own context would see one row) and
        // handed to the query as a seller exclusion. Without this a tenant
        // that disabled the module kept its offers on the public map while
        // losing the ability to withdraw them.
        expect(repo.listTenantIdsWithModuleDisabled).toHaveBeenCalledWith(mockDb, 'EXCHANGE');
        expect(repo.listActiveListings).toHaveBeenCalledWith(
            mockDb,
            expect.objectContaining({ excludeSellerTenantIds: ['tenant-2'] }),
            {},
        );
    });
});

/**
 * The listing EDIT — #2543. Owner ruling 2026-10-31: every field editable,
 * and a later `expiresAt` reactivates an EXPIRED listing.
 */
describe('updateListingFields', () => {
    const NOW = new Date('2026-10-31T12:00:00.000Z');
    const FUTURE = '2027-06-01T00:00:00.000Z';

    /** A complete body — the edit is a FULL replacement, so nothing is partial. */
    function body(over: Record<string, unknown> = {}) {
        return {
            side: 'SELL',
            kind: 'CULTURE',
            commodity: 'Barley',
            quantityTonnes: 25,
            pricePerTonne: 180,
            priceCurrency: 'EUR',
            regionCode: 'BG-16',
            description: 'Clean, 12% protein',
            sellerDisplayName: 'Иван, лично',
            publishAsFarm: false,
            sellerContact: '+359 888 123456',
            expiresAt: FUTURE,
            updatedAt: NOW.toISOString(),
            ...over,
        } as unknown as UpdateListingBody;
    }

    function owned(over: Record<string, unknown> = {}) {
        return listing({ sellerTenantId: 'tenant-1', updatedAt: NOW, ...over });
    }

    beforeEach(() => {
        repo.updateListingFields.mockImplementation(async (_db, _id, data) =>
            ({ ...owned(), ...data }),
        );
    });

    it('replaces every editable field, and FORCES the price currency', async () => {
        repo.getListing.mockResolvedValue(owned());

        await updateListingFields(meCtx, 'lst-1', body({ priceCurrency: 'USD' }));

        const data = repo.updateListingFields.mock.calls[0][2];
        expect(data).toMatchObject({
            side: 'SELL',
            kind: 'CULTURE',
            commodity: 'Barley',
            quantityTonnes: 25,
            sellerContact: '+359 888 123456',
        });
        // The body carries `priceCurrency` so the seller's `edit` object
        // round-trips, NOT so a client can pick a currency. The create path
        // forces it the same way.
        expect(data.priceCurrency).toBe('EUR');
    });

    it('refuses ANOTHER tenant’s listing with LISTING_NOT_OWNED', async () => {
        repo.getListing.mockResolvedValue(owned({ sellerTenantId: otherTenantId }));

        await expect(updateListingFields(meCtx, 'lst-1', body())).rejects.toMatchObject({
            code: 'LISTING_NOT_OWNED',
        });
        expect(repo.updateListingFields).not.toHaveBeenCalled();
    });

    it.each(['WITHDRAWN', 'FULFILLED'])('refuses a %s listing with LISTING_TERMINAL', async (status) => {
        repo.getListing.mockResolvedValue(owned({ status }));

        await expect(updateListingFields(meCtx, 'lst-1', body())).rejects.toMatchObject({
            code: 'LISTING_TERMINAL',
        });
        expect(repo.updateListingFields).not.toHaveBeenCalled();
    });

    it('refuses a STALE precondition with LISTING_MODIFIED', async () => {
        // Somebody else saved in between. Under a full replacement this is the
        // difference between losing one field and losing all of them.
        repo.getListing.mockResolvedValue(owned({ updatedAt: new Date('2026-10-31T12:05:00.000Z') }));

        await expect(updateListingFields(meCtx, 'lst-1', body())).rejects.toMatchObject({
            code: 'LISTING_MODIFIED',
        });
        expect(repo.updateListingFields).not.toHaveBeenCalled();
    });

    it('refuses an UNPARSEABLE precondition rather than treating it as a match', async () => {
        // Fails CLOSED: a client that cannot echo the precondition has not
        // satisfied it, and `new Date('nonsense').getTime()` is NaN — which
        // `!==` would have let through if the comparison were the only check.
        repo.getListing.mockResolvedValue(owned());

        await expect(
            updateListingFields(meCtx, 'lst-1', body({ updatedAt: 'not-a-date' })),
        ).rejects.toMatchObject({ code: 'LISTING_MODIFIED' });
    });

    it('accepts a precondition that is the same INSTANT spelled differently', async () => {
        // `updatedAt` round-trips through `toISOString()`; two spellings of one
        // moment must not read as a conflict.
        repo.getListing.mockResolvedValue(owned({ updatedAt: NOW }));

        await updateListingFields(meCtx, 'lst-1', body({ updatedAt: '2026-10-31T12:00:00Z' }));

        expect(repo.updateListingFields).toHaveBeenCalledTimes(1);
    });

    it('REACTIVATES an expired listing, and checks the plan limit when it does', async () => {
        repo.getListing.mockResolvedValue(owned({ status: 'EXPIRED' }));

        await updateListingFields(meCtx, 'lst-1', body());

        expect(repo.updateListingFields.mock.calls[0][2]).toMatchObject({ status: 'ACTIVE' });
        // EXPIRED → ACTIVE raises the ACTIVE count, so the quota applies. A
        // tenant at its cap could otherwise walk past it by reactivating
        // lapsed rows one at a time.
        expect(assertWithinLimitMock).toHaveBeenCalledWith(meCtx, 'exchange_listing', expect.anything());
    });

    it('treats NO expiry as later than any date, and reactivates too', async () => {
        // "No expiry" is later than every instant, so the owner's ruling that a
        // later expiry reactivates covers it.
        repo.getListing.mockResolvedValue(owned({ status: 'EXPIRED' }));

        await updateListingFields(meCtx, 'lst-1', body({ expiresAt: null }));

        expect(repo.updateListingFields.mock.calls[0][2]).toMatchObject({
            status: 'ACTIVE',
            expiresAt: null,
        });
    });

    it('leaves an ACTIVE listing ACTIVE and does NOT spend the quota on it', async () => {
        repo.getListing.mockResolvedValue(owned({ status: 'ACTIVE' }));

        await updateListingFields(meCtx, 'lst-1', body());

        expect(repo.updateListingFields.mock.calls[0][2]).toMatchObject({ status: 'ACTIVE' });
        // An ordinary edit cannot change the ACTIVE count, so a quota it
        // cannot affect must not be able to refuse it.
        expect(assertWithinLimitMock).not.toHaveBeenCalled();
    });

    it('accepts an UNCHANGED expiry even when it has already passed', async () => {
        /*
         * The iOS session found this before it shipped. `edit` round-trips
         * `expiresAt` as a string, so a client that does not touch the date
         * sends it back verbatim — and the create schema's "must be in the
         * future" rule, inherited by the edit, would refuse an edit to a
         * listing ON ITS LAST DAY for a field nobody changed. The refusal
         * would also name a field the seller never saw.
         */
        const PAST = '2026-10-30T00:00:00.000Z';
        repo.getListing.mockResolvedValue(owned({ expiresAt: new Date(PAST) }));

        await updateListingFields(meCtx, 'lst-1', body({ expiresAt: PAST }));

        expect(repo.updateListingFields).toHaveBeenCalledTimes(1);
    });

    it('accepts an unchanged NULL expiry, which is not a change either', async () => {
        repo.getListing.mockResolvedValue(owned({ expiresAt: null }));

        await updateListingFields(meCtx, 'lst-1', body({ expiresAt: null }));

        expect(repo.updateListingFields.mock.calls[0][2]).toMatchObject({ expiresAt: null });
    });

    it('refuses a CHANGED expiry that is in the past', async () => {
        // The rule the create schema was reaching for, applied where the
        // stored value is known: changing the date to a past one would hide
        // the listing the moment it saved.
        repo.getListing.mockResolvedValue(owned({ expiresAt: new Date('2027-01-01T00:00:00.000Z') }));

        await expect(
            updateListingFields(meCtx, 'lst-1', body({ expiresAt: '2026-10-30T00:00:00.000Z' })),
        ).rejects.toMatchObject({ code: 'LISTING_EXPIRES_AT_IN_PAST' });
        expect(repo.updateListingFields).not.toHaveBeenCalled();
    });

    it('treats two spellings of the same expiry instant as unchanged', async () => {
        // Same moment, different string. A client echoing the value it was
        // given must not trip the changed-expiry rule on formatting alone.
        const PAST = '2026-10-30T00:00:00.000Z';
        repo.getListing.mockResolvedValue(owned({ expiresAt: new Date(PAST) }));

        await updateListingFields(meCtx, 'lst-1', body({ expiresAt: '2026-10-30T00:00:00Z' }));

        expect(repo.updateListingFields).toHaveBeenCalledTimes(1);
    });

    it('refuses an unknown region BEFORE opening a transaction', async () => {
        repo.getListing.mockResolvedValue(owned());

        await expect(
            updateListingFields(meCtx, 'lst-1', body({ regionCode: 'BG-99' })),
        ).rejects.toMatchObject({ code: 'LISTING_REGION_UNKNOWN' });
        // Resolved before the read, so an unknown code costs no transaction.
        expect(repo.getListing).not.toHaveBeenCalled();
    });

    it('derives region NAME and coordinates from the code, never from the body', async () => {
        repo.getListing.mockResolvedValue(owned());

        await updateListingFields(meCtx, 'lst-1', body());

        const data = repo.updateListingFields.mock.calls[0][2];
        expect(data.regionCode).toBe('BG-16');
        // A client cannot name an oblast something else: the English name and
        // the coordinates come from the region table, as on the create path.
        expect(typeof data.regionName).toBe('string');
        expect(data.regionName.length).toBeGreaterThan(0);
        expect(typeof data.lat).toBe('number');
        expect(typeof data.lon).toBe('number');
    });
});

/**
 * #2564 — three refusals about a listing that is not ACTIVE, and the property
 * is that they stay TOLD APART.
 *
 * Written as a COMPARISON rather than three independent code assertions,
 * because the defect being guarded is not "this site returns the wrong code" —
 * each site's code was individually defensible — it is that three sites SHARED
 * one, and `localizeErrorPayload` then gave all three the sentence written for
 * one of them. Three separate `toMatchObject({ code })` tests all pass happily
 * on the day somebody collapses two of them back together and updates both
 * expectations; this one does not.
 *
 * The second half is the half that reaches a farmer. Distinct CODES with equal
 * SENTENCES would satisfy a code-only check while putting the wrong advice back
 * in front of the wrong reader, which is the whole of #2564.
 */
describe('#2564 — the three not-active refusals stay distinguishable', () => {
    async function codeOf(run: () => Promise<unknown>): Promise<string> {
        try {
            await run();
        } catch (err) {
            const e = err as { code?: string; message?: string };
            // Reports the MESSAGE when there is no code, because "NO_CODE"
            // alone cannot tell an uncoded refusal from the probe's own setup
            // throwing — two very different findings that read identically.
            return e.code ?? `NO_CODE: ${e.message ?? String(err)}`;
        }
        throw new Error('expected a refusal, got none — the probe proves nothing');
    }

    it('three sites, three codes, and three sentences in BOTH locales', async () => {
        const fulfil = await codeOf(() => {
            repo.getListing.mockResolvedValue(listing({ status: 'EXPIRED' }));
            return fulfillListing(meCtx, 'lst-1');
        });
        const enquire = await codeOf(() => {
            repo.getListing.mockResolvedValue(
                listing({ sellerTenantId: otherTenantId, status: 'FULFILLED' }),
            );
            return createInquiry(meCtx, { listingId: 'lst-1', message: 'interested' });
        });
        const accept = await codeOf(() => {
            // A MINIMAL inquiry rather than the sibling describe's `inq`
            // fixture, which is scoped to it. Minimal is also more honest
            // here: these four fields are exactly what the refusal reads —
            // PENDING so the earlier guard passes, the seller tenant so it is
            // the caller's to answer, and a non-ACTIVE listing as the cause.
            repo.getInquiry.mockResolvedValue({
                id: 'inq-1',
                status: 'PENDING',
                listing: {
                    id: 'lst-1',
                    sellerTenantId: meCtx.tenantId,
                    commodity: 'Wheat',
                    status: 'EXPIRED',
                },
            } as never);
            return respondToInquiry(meCtx, 'inq-1', 'ACCEPTED');
        });

        expect(fulfil).toBe('LISTING_FULFIL_REQUIRES_ACTIVE');
        expect(enquire).toBe('LISTING_NOT_ACTIVE');
        expect(accept).toBe('INQUIRY_ACCEPT_REQUIRES_ACTIVE_LISTING');
        // The comparison itself, stated separately so a failure reads as
        // "two of these are the same code" rather than as one wrong value.
        expect(new Set([fulfil, enquire, accept]).size).toBe(3);

        // And what the reader actually gets. `localizeErrorPayload` keys on the
        // code, so distinct codes with identical entries would put the fulfil
        // advice back in front of a buyer while every code assertion above
        // stayed green.
        for (const locale of ['en', 'bg'] as const) {
            // `readFileSync`, not `require`: a dynamic `require` needs a
            // directive to silence two rules, and the directive turned out to
            // suppress only one of them — so it read as settled while eslint
            // still reported the finding AND the directive as unused. The
            // guards in this repo read catalogues this way for the same reason.
            const messages = JSON.parse(
                readFileSync(join(process.cwd(), 'messages', locale, 'app.json'), 'utf8'),
            ) as { errors: Record<string, string> };
            const sentences = [fulfil, enquire, accept].map((c) => {
                const s = messages.errors[c];
                expect(typeof s).toBe('string');
                return s;
            });
            expect(new Set(sentences).size).toBe(3);
            // The fulfil one is the only one entitled to say "withdraw", and
            // the buyer's must not: they cannot withdraw a listing they do not
            // own, which is the sentence that was reaching them before #2564.
            const buyer = messages.errors[enquire].toLowerCase();
            expect(buyer).not.toMatch(locale === 'bg' ? /оттегл/ : /withdraw/);
        }
    });
});
