/**
 * A person block reveals NOTHING to the person it refuses (P5.2b, #1593).
 *
 * Owner ruling 2026-10-10. This is the test that makes the claim checkable,
 * and it is written as a COMPARISON rather than as a list of expectations,
 * because "it was refused" is not the property — the property is that the
 * refusal is **identical** to a refusal with an innocent cause.
 *
 * ## Why a comparison and not assertions
 *
 * A test asserting `code === 'THREAD_NOT_FOUND'` would pass on an
 * implementation that returned that code with a different message, a different
 * status, or an extra field. Any of those is a tell. So each case here runs the
 * SAME call twice — once blocked, once with the subject genuinely missing — and
 * requires the two results to match on every observable.
 *
 * That also means the test cannot be satisfied by weakening it: making the two
 * agree is the only way through, and the innocent case is fixed by the
 * product rather than by this file.
 *
 * ## The two block tables have OPPOSITE disclosure rules
 *
 * The exchange block TELLS the buyer — `THREAD_BLOCKED` plus a sentence —
 * because that is a commercial refusal a buyer is entitled to understand, and
 * the owner confirmed it stays. The person block must reveal nothing. Both are
 * asserted here, together, because the thing most likely to go wrong is
 * somebody making them consistent.
 *
 * ## What this does NOT claim
 *
 * Response-level indistinguishability only. Timing is not equalised: a person
 * block costs an extra indexed lookup, and the listing stays visible in the
 * marketplace while one person gets a not-found. A determined blocked user can
 * infer a block. Saying so rather than implying the mechanism is stronger than
 * it is.
 */
const mockPrisma = {
    exchangeListing: { findFirst: jest.fn() },
    exchangeThread: { findFirst: jest.fn(), findMany: jest.fn() },
    exchangeBlock: { findFirst: jest.fn() },
    userBlock: { findFirst: jest.fn(), findMany: jest.fn() },
    // The rest of what a SUCCESSFUL thread read touches. Present so the
    // positive cases below can get all the way through — without them the
    // "blocker still reads it" test fails on a mock gap and would have been
    // mistaken for the block refusing the wrong party.
    exchangeMessage: { findMany: jest.fn(), count: jest.fn() },
    exchangeThreadRead: { updateMany: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
    user: { findMany: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) => cb(mockPrisma),
    withTenantDb: (_t: unknown, cb: (db: unknown) => unknown) => cb(mockPrisma),
    runInUserContext: (_ctx: unknown, cb: (db: unknown) => unknown) => cb(mockPrisma),
}));

import { openExchangeThread, getExchangeThread } from '@/app-layer/usecases/exchange-messaging';
import { makeRequestContext } from '../helpers/make-context';

const BUYER_TENANT = 't-buyer';
const BUYER_USER = 'u-buyer';
const SELLER_TENANT = 't-seller';
const SELLER_USER = 'u-seller';

const buyerCtx = makeRequestContext('ADMIN', {
    tenantId: BUYER_TENANT,
    userId: BUYER_USER,
    requestId: 'req-buyer',
});

const LISTING = { id: 'lst-1', sellerTenantId: SELLER_TENANT, sellerUserId: SELLER_USER };
const THREAD = {
    id: 'thr-1',
    listingId: 'lst-1',
    inquirerTenantId: BUYER_TENANT,
    inquirerUserId: BUYER_USER,
    lastMessageAt: new Date('2026-10-01T00:00:00Z'),
    closedAt: null,
    listing: { sellerTenantId: SELLER_TENANT, sellerUserId: SELLER_USER, commodity: 'WHEAT' },
    reads: [],
};

/** Everything a client can observe about a thrown refusal. */
function observable(err: unknown): Record<string, unknown> {
    const e = err as Record<string, unknown> & { message?: string };
    return {
        name: (e as { constructor?: { name?: string } }).constructor?.name,
        message: e.message,
        code: e.code,
        statusCode: e.statusCode,
        // Any extra enumerable field is itself a tell.
        keys: Object.keys(e).sort(),
    };
}

async function refusalOf(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
        await fn();
    } catch (err) {
        return observable(err);
    }
    throw new Error('expected a refusal, got a result');
}

beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.exchangeBlock.findFirst.mockResolvedValue(null);
    mockPrisma.userBlock.findFirst.mockResolvedValue(null);
    mockPrisma.userBlock.findMany.mockResolvedValue([]);
    mockPrisma.exchangeMessage.findMany.mockResolvedValue([]);
    mockPrisma.exchangeMessage.count.mockResolvedValue(0);
    mockPrisma.exchangeThreadRead.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.exchangeThreadRead.findFirst.mockResolvedValue(null);
    mockPrisma.user.findMany.mockResolvedValue([]);
});

describe('opening a thread — a person block looks like a missing listing', () => {
    it('is byte-for-byte the same refusal', async () => {
        // (a) the innocent cause: there is no such listing.
        mockPrisma.exchangeListing.findFirst.mockResolvedValue(null);
        const innocent = await refusalOf(() => openExchangeThread(buyerCtx, 'lst-1'));

        // (b) the listing EXISTS and the seller has blocked this person.
        mockPrisma.exchangeListing.findFirst.mockResolvedValue(LISTING);
        mockPrisma.userBlock.findFirst.mockResolvedValue({ id: 'ub-1' });
        const blocked = await refusalOf(() => openExchangeThread(buyerCtx, 'lst-1'));

        // The whole point. Not "it was refused" — IDENTICAL.
        expect(blocked).toEqual(innocent);
        // And pinned concretely, so a future change that made both of them
        // something else still has to be deliberate about it.
        expect(blocked.code).toBe('LISTING_NOT_FOUND');
    });

    it('the EXCHANGE block is loud, by contrast — and that is deliberate', async () => {
        // The owner confirmed the exchange keeps telling a buyer that a seller
        // will not deal with them. Asserted beside the silent case because the
        // likeliest regression is somebody making the two consistent.
        mockPrisma.exchangeListing.findFirst.mockResolvedValue(LISTING);
        mockPrisma.exchangeBlock.findFirst.mockResolvedValue({ id: 'eb-1' });
        const loud = await refusalOf(() => openExchangeThread(buyerCtx, 'lst-1'));

        expect(loud.code).toBe('THREAD_BLOCKED');
        expect(String(loud.message)).toMatch(/not accepting messages/i);

        mockPrisma.exchangeListing.findFirst.mockResolvedValue(null);
        const innocent = await refusalOf(() => openExchangeThread(buyerCtx, 'lst-1'));
        expect(loud).not.toEqual(innocent);
    });
});

describe('reading a thread — a person block looks like a missing thread', () => {
    it('is byte-for-byte the same refusal', async () => {
        mockPrisma.exchangeThread.findFirst.mockResolvedValue(null);
        const innocent = await refusalOf(() => getExchangeThread(buyerCtx, 'thr-1'));

        mockPrisma.exchangeThread.findFirst.mockResolvedValue(THREAD);
        // The SELLER has blocked the buyer, so the buyer loses the thread.
        mockPrisma.userBlock.findFirst.mockResolvedValue({ id: 'ub-1' });
        const blocked = await refusalOf(() => getExchangeThread(buyerCtx, 'thr-1'));

        expect(blocked).toEqual(innocent);
        expect(blocked.code).toBe('THREAD_NOT_FOUND');
    });

    it('the BLOCKER still reads the thread — one-directional by design', async () => {
        // Visibility is lost by the blocked party only; the blocker keeps
        // their history. `amIBlockedByAnyOf` asks "has the other party blocked
        // ME", so a block the caller MADE returns no row for this query.
        mockPrisma.exchangeThread.findFirst.mockResolvedValue(THREAD);
        mockPrisma.exchangeThread.findMany.mockResolvedValue([]);
        mockPrisma.userBlock.findFirst.mockResolvedValue(null);

        await expect(getExchangeThread(buyerCtx, 'thr-1')).resolves.toBeDefined();
        // And the query really was the one-directional one, not a bidirectional
        // check that happened to return null.
        const where = mockPrisma.userBlock.findFirst.mock.calls[0][0].where;
        expect(where.blockedUserId).toBe(BUYER_USER);
        expect(where).not.toHaveProperty('OR');
    });
});

describe('the visibility check runs at the choke point, not per call site', () => {
    it('reaches userBlock on a thread read at all — the control', async () => {
        // Without this, every "identical refusal" assertion above would also
        // pass on an implementation that never consulted `UserBlock` and
        // simply 404ed for an unrelated reason.
        mockPrisma.exchangeThread.findFirst.mockResolvedValue(THREAD);
        mockPrisma.exchangeThread.findMany.mockResolvedValue([]);
        await getExchangeThread(buyerCtx, 'thr-1');
        expect(mockPrisma.userBlock.findFirst).toHaveBeenCalled();
    });

    it('considers BOTH named people on the thread as candidate blockers', async () => {
        mockPrisma.exchangeThread.findFirst.mockResolvedValue(THREAD);
        mockPrisma.exchangeThread.findMany.mockResolvedValue([]);
        await getExchangeThread(buyerCtx, 'thr-1');
        const where = mockPrisma.userBlock.findFirst.mock.calls[0][0].where;
        // The caller's own id is dropped (you cannot block yourself into
        // invisibility), leaving the counterparty.
        expect(where.blockerUserId.in).toContain(SELLER_USER);
        expect(where.blockerUserId.in).not.toContain(BUYER_USER);
    });
});
