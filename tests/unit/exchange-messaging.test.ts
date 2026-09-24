/**
 * Exchange messaging — the behaviours that are wrong in ways nobody notices.
 *
 * CRUD is not what this pins. These are:
 *
 *   - the read pointer is MONOTONIC. Two tabs answering out of order rewind it,
 *     and the symptom is an unread badge resurrecting messages the user read —
 *     which looks like a bug in the badge, the last place anyone looks.
 *   - scrollback is selected NEWEST-first and reversed. Sorting ascending and
 *     taking a limit returns the START of a long thread: correct-looking code,
 *     wrong end of the conversation.
 *   - a deleted message is a TOMBSTONE. Dropping it leaves a hole where the
 *     other party read something, which reads as data loss, not a retraction.
 *   - sanitising happens BEFORE the length check, so markup cannot pad a
 *     message past the limit.
 */
const mockPrisma = {
    exchangeListing: { findFirst: jest.fn() },
    exchangeThread: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    exchangeMessage: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, prisma: mockPrisma, default: mockPrisma }));
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) => cb(mockPrisma),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import {
    openExchangeThread,
    getExchangeThread,
    sendExchangeMessage,
    markExchangeThreadRead,
    deleteExchangeMessage,
} from '@/app-layer/usecases/exchange-messaging';
import type { RequestContext } from '@/app-layer/types';

const BUYER = 'tnt_buyer';
const SELLER = 'tnt_seller';

function ctxFor(tenantId: string) {
    return {
        requestId: 'r', userId: 'usr_1', tenantId, tenantSlug: 'acme', role: 'EDITOR',
        permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false },
        appPermissions: {},
    } as unknown as RequestContext;
}
const buyerCtx = ctxFor(BUYER);
const sellerCtx = ctxFor(SELLER);

function thread(over: Record<string, unknown> = {}) {
    return {
        id: 'th1', listingId: 'lst1', inquirerTenantId: BUYER,
        lastMessageAt: new Date('2026-09-01T10:00:00Z'), closedAt: null,
        sellerLastReadAt: null, inquirerLastReadAt: null,
        listing: { sellerTenantId: SELLER, commodity: 'wheat' },
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.exchangeThread.findFirst.mockResolvedValue(thread());
    mockPrisma.exchangeMessage.findMany.mockResolvedValue([]);
    mockPrisma.exchangeThread.update.mockResolvedValue({});
    mockPrisma.exchangeMessage.update.mockResolvedValue({});
    mockPrisma.exchangeMessage.create.mockResolvedValue({ id: 'm1', createdAt: new Date() });
    mockPrisma.exchangeThread.create.mockResolvedValue({ id: 'th_new' });
    mockPrisma.exchangeListing.findFirst.mockResolvedValue({ id: 'lst1', sellerTenantId: SELLER });
});

describe('opening a thread', () => {
    it('is idempotent — a second tap returns the SAME thread', async () => {
        mockPrisma.exchangeThread.findFirst.mockResolvedValue({ id: 'th1' });
        const r = await openExchangeThread(buyerCtx, 'lst1');
        expect(r).toEqual({ id: 'th1', created: false });
        expect(mockPrisma.exchangeThread.create).not.toHaveBeenCalled();
    });

    it('creates one when none exists', async () => {
        mockPrisma.exchangeThread.findFirst.mockResolvedValue(null);
        const r = await openExchangeThread(buyerCtx, 'lst1');
        expect(r).toEqual({ id: 'th_new', created: true });
    });

    it('refuses a seller opening a thread on their OWN listing', async () => {
        // There would be no second party. Sellers reply; they do not initiate.
        await expect(openExchangeThread(sellerCtx, 'lst1')).rejects.toThrow(/own listing/i);
    });
});

describe('the read pointer is monotonic', () => {
    it('does NOT move backwards when a stale request arrives late', async () => {
        // The failure this prevents: two tabs, the older one answering second,
        // the pointer rewinding, and already-read messages going unread again.
        const future = new Date(Date.now() + 60_000);
        mockPrisma.exchangeThread.findFirst.mockResolvedValue(
            thread({ inquirerLastReadAt: future }),
        );
        const r = await markExchangeThreadRead(buyerCtx, 'th1');
        expect(r.readAt).toBe(future);
        expect(mockPrisma.exchangeThread.update).not.toHaveBeenCalled();
    });

    it('moves the pointer forward on a normal read', async () => {
        // The positive control — without it, a function that never updated
        // anything would satisfy the assertion above.
        await markExchangeThreadRead(buyerCtx, 'th1');
        expect(mockPrisma.exchangeThread.update).toHaveBeenCalled();
    });

    it('moves the SELLER pointer when the seller reads, not the buyer one', async () => {
        await markExchangeThreadRead(sellerCtx, 'th1');
        const { data } = mockPrisma.exchangeThread.update.mock.calls[0][0];
        expect(data).toHaveProperty('sellerLastReadAt');
        expect(data).not.toHaveProperty('inquirerLastReadAt');
    });
});

describe('the scrollback', () => {
    it('SELECTS newest-first, so a long thread returns its end', async () => {
        await getExchangeThread(buyerCtx, 'th1');
        const args = mockPrisma.exchangeMessage.findMany.mock.calls[0][0];
        expect(args.orderBy).toEqual({ createdAt: 'desc' });
        expect(args.take).toBeGreaterThan(0);
    });

    it('RETURNS oldest-first, which is reading order', async () => {
        mockPrisma.exchangeMessage.findMany.mockResolvedValue([
            { id: 'newer', senderTenantId: BUYER, body: 'second', deletedAt: null, createdAt: new Date('2026-09-02') },
            { id: 'older', senderTenantId: BUYER, body: 'first', deletedAt: null, createdAt: new Date('2026-09-01') },
        ]);
        const view = await getExchangeThread(buyerCtx, 'th1');
        expect(view.messages.map((m) => m.id)).toEqual(['older', 'newer']);
    });

    it('marks the caller\'s own messages with `mine`, from either side', async () => {
        mockPrisma.exchangeMessage.findMany.mockResolvedValue([
            { id: 'a', senderTenantId: BUYER, body: 'hi', deletedAt: null, createdAt: new Date() },
            { id: 'b', senderTenantId: SELLER, body: 'hello', deletedAt: null, createdAt: new Date() },
        ]);
        const asBuyer = await getExchangeThread(buyerCtx, 'th1');
        expect(asBuyer.messages.find((m) => m.id === 'a')?.mine).toBe(true);
        expect(asBuyer.messages.find((m) => m.id === 'b')?.mine).toBe(false);

        const asSeller = await getExchangeThread(sellerCtx, 'th1');
        expect(asSeller.messages.find((m) => m.id === 'a')?.mine).toBe(false);
        expect(asSeller.messages.find((m) => m.id === 'b')?.mine).toBe(true);
    });

    it('does not FILTER OUT deleted messages at the query', async () => {
        // The assertion the tombstone test cannot make. The mock ignores
        // `where`, so adding `deletedAt: null` to the query would hide every
        // tombstone and the mapping test below would still pass — I checked,
        // by making that exact change. Assert the query itself.
        await getExchangeThread(buyerCtx, 'th1');
        const { where } = mockPrisma.exchangeMessage.findMany.mock.calls[0][0];
        expect(where).toEqual({ threadId: 'th1' });
        expect(where).not.toHaveProperty('deletedAt');
    });

    it('renders a deleted message as a tombstone, keeping its place', async () => {
        mockPrisma.exchangeMessage.findMany.mockResolvedValue([
            { id: 'gone', senderTenantId: SELLER, body: 'secret', deletedAt: new Date(), createdAt: new Date() },
        ]);
        const view = await getExchangeThread(buyerCtx, 'th1');
        expect(view.messages).toHaveLength(1);        // kept
        expect(view.messages[0].deleted).toBe(true);
        expect(view.messages[0].body).toBeNull();     // and the body withheld
    });

    it('counts only the OTHER party\'s messages as unread', async () => {
        mockPrisma.exchangeThread.findFirst.mockResolvedValue(
            thread({ inquirerLastReadAt: new Date('2026-08-01') }),
        );
        mockPrisma.exchangeMessage.findMany.mockResolvedValue([
            { id: 'mine', senderTenantId: BUYER, body: 'x', deletedAt: null, createdAt: new Date('2026-09-02') },
            { id: 'theirs', senderTenantId: SELLER, body: 'y', deletedAt: null, createdAt: new Date('2026-09-02') },
        ]);
        const view = await getExchangeThread(buyerCtx, 'th1');
        expect(view.unreadCount).toBe(1);
    });
});

describe('sending', () => {
    it('sanitises BEFORE measuring, so markup cannot pad past the limit', async () => {
        // 4000 is the cap. This is well over it in raw characters and well
        // under once the markup is stripped.
        const padded = '<b>'.repeat(2000) + 'ok' + '</b>'.repeat(2000);
        await expect(sendExchangeMessage(buyerCtx, 'th1', padded)).resolves.toBeDefined();
    });

    it('refuses an empty message, and one that is only whitespace', async () => {
        await expect(sendExchangeMessage(buyerCtx, 'th1', '   ')).rejects.toThrow(/message/i);
    });

    it('refuses a closed thread', async () => {
        mockPrisma.exchangeThread.findFirst.mockResolvedValue(thread({ closedAt: new Date() }));
        await expect(sendExchangeMessage(buyerCtx, 'th1', 'hello')).rejects.toThrow(/closed/i);
    });

    it('bumps lastMessageAt so the inbox sorts correctly', async () => {
        await sendExchangeMessage(buyerCtx, 'th1', 'hello');
        const { data } = mockPrisma.exchangeThread.update.mock.calls[0][0];
        expect(data.lastMessageAt).toBeInstanceOf(Date);
    });

    it('refuses a tenant that is party to neither side', async () => {
        await expect(sendExchangeMessage(ctxFor('tnt_stranger'), 'th1', 'hi'))
            .rejects.toThrow(/not a party/i);
    });
});

describe('retracting', () => {
    it('only the sender may retract', async () => {
        mockPrisma.exchangeMessage.findFirst.mockResolvedValue({
            id: 'm1', senderTenantId: SELLER, threadId: 'th1', deletedAt: null,
        });
        await expect(deleteExchangeMessage(buyerCtx, 'm1')).rejects.toThrow(/your own/i);
    });

    it('is a soft delete, not a removal', async () => {
        mockPrisma.exchangeMessage.findFirst.mockResolvedValue({
            id: 'm1', senderTenantId: BUYER, threadId: 'th1', deletedAt: null,
        });
        await deleteExchangeMessage(buyerCtx, 'm1');
        const { data } = mockPrisma.exchangeMessage.update.mock.calls[0][0];
        expect(data.deletedAt).toBeInstanceOf(Date);
    });

    it('retracting twice is not an error', async () => {
        mockPrisma.exchangeMessage.findFirst.mockResolvedValue({
            id: 'm1', senderTenantId: BUYER, threadId: 'th1', deletedAt: new Date(),
        });
        await expect(deleteExchangeMessage(buyerCtx, 'm1')).resolves.toEqual({ id: 'm1' });
        expect(mockPrisma.exchangeMessage.update).not.toHaveBeenCalled();
    });
});
