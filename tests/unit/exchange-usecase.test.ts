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
    // The RLS-free read of "which tenants switched EXCHANGE off". Same stub db;
    // the repository call is mocked, so only the wiring matters here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runInGlobalContext: jest.fn(async (fn: (db: any) => any) => fn(mockDb)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    withTenantDb: jest.fn(async (tenantId: string, fn: (db: any) => any) => {
        withTenantDbCalls.push(tenantId);
        return fn(mockSellerDb);
    }),
}));

jest.mock('@/app-layer/repositories/exchange', () => ({
    ExchangeRepository: {
        listActiveListings: jest.fn(),
        listTenantIdsWithModuleDisabled: jest.fn().mockResolvedValue([]),
        getListing: jest.fn(),
        createListing: jest.fn(),
        updateListingStatus: jest.fn(),
        createInquiry: jest.fn(),
        listInquiriesByInquirer: jest.fn(),
        getInquiry: jest.fn(),
        updateInquiryStatus: jest.fn(),
        declinePendingInquiries: jest.fn(),
        listListingsBySeller: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

// Keep sanitize a passthrough — the sanitiser has its own tests; here we
// only care that free text flows through it (identity is enough).
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (s: string | null | undefined) => (s == null ? '' : s),
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
jest.mock('@/lib/billing/entitlements', () => ({
    assertWithinLimit: jest.fn().mockResolvedValue(undefined),
}));

import { ExchangeRepository } from '@/app-layer/repositories/exchange';
import {
    listActiveListings,
    createListing,
    withdrawListing,
    fulfillListing,
    createInquiry,
    respondToInquiry,
} from '@/app-layer/usecases/exchange';
import { assertWithinLimit } from '@/lib/billing/entitlements';
import { forbidden } from '@/lib/errors/types';
import { Prisma } from '@prisma/client';
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
        await expect(withdrawListing(meCtx, 'lst-1')).rejects.toThrow(/your own listings/i);
        expect(repo.updateListingStatus).not.toHaveBeenCalled();
    });

    it('fulfillListing on ANOTHER tenant’s listing throws forbidden', async () => {
        repo.getListing.mockResolvedValue(listing({ sellerTenantId: otherTenantId }));
        await expect(fulfillListing(meCtx, 'lst-1')).rejects.toThrow(/your own listings/i);
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
        ).rejects.toThrow(/your own listing/i);
        expect(repo.createInquiry).not.toHaveBeenCalled();
    });

    it('inquiring on a non-ACTIVE listing throws badRequest', async () => {
        repo.getListing.mockResolvedValue(listing({ sellerTenantId: otherTenantId, status: 'FULFILLED' }));
        await expect(
            createInquiry(meCtx, { listingId: 'lst-1', message: 'interested' }),
        ).rejects.toThrow(/listing_not_active/i);
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
        repo.getInquiry.mockResolvedValue(inq({ listing: { sellerTenantId: 'tenant-9', commodity: 'Wheat', status: 'ACTIVE' } }) as never);
        await expect(respondToInquiry(meCtx, 'inq-1', 'DECLINED')).rejects.toThrow(/inquiry not found/i);
        expect(repo.updateInquiryStatus).not.toHaveBeenCalled();

        // …and a genuinely missing inquiry throws the SAME error.
        repo.getInquiry.mockResolvedValue(null as never);
        await expect(respondToInquiry(meCtx, 'inq-1', 'DECLINED')).rejects.toThrow(/inquiry not found/i);
    });

    it('an already-answered inquiry → badRequest', async () => {
        repo.getInquiry.mockResolvedValue(inq({ status: 'ACCEPTED' }) as never);
        await expect(respondToInquiry(meCtx, 'inq-1', 'DECLINED')).rejects.toThrow(/not_pending/i);
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
            await expect(respondToInquiry(meCtx, 'inq-1', 'ACCEPTED')).rejects.toThrow(/listing_not_active/i);
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

describe('listing state machine (FULFILLED / WITHDRAWN are terminal)', () => {
    it.each(['FULFILLED', 'WITHDRAWN'])(
        'refuses to withdraw an already-%s listing',
        async (status) => {
            repo.getListing.mockResolvedValue(listing({ status }));
            await expect(withdrawListing(meCtx, 'lst-1')).rejects.toThrow(/listing_terminal/i);
            expect(repo.updateListingStatus).not.toHaveBeenCalled();
        },
    );

    it.each(['FULFILLED', 'WITHDRAWN'])(
        'refuses to fulfil an already-%s listing (closes the FULFILLED→WITHDRAWN→FULFILLED loop)',
        async (status) => {
            repo.getListing.mockResolvedValue(listing({ status }));
            await expect(fulfillListing(meCtx, 'lst-1')).rejects.toThrow(/listing_terminal/i);
            expect(repo.updateListingStatus).not.toHaveBeenCalled();
        },
    );

    it('refuses EXPIRED → FULFILLED — a lapsed listing is no evidence of a sale', async () => {
        repo.getListing.mockResolvedValue(listing({ status: 'EXPIRED' }));
        await expect(fulfillListing(meCtx, 'lst-1')).rejects.toThrow(/listing_not_active/i);
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
