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
    exchangeBlock: { findFirst: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, prisma: mockPrisma, default: mockPrisma }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
const enqueueEmail = jest.fn();
jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: (...a: unknown[]) => enqueueEmail(...a),
}));
const mockRecipientDb = {
    tenantMembership: { findMany: jest.fn() },
    notification: { create: jest.fn() },
};
// Echoes the locale back so a test can prove WHICH language was used —
// a translator mocked to a constant would pass whether the recipient's
// uiLanguage was honoured or silently replaced by a default.
const translateFor = jest.fn(
    (locale: string, key: string, params?: Record<string, unknown>) =>
        Promise.resolve(`${locale}|${key}${params ? `|${JSON.stringify(params)}` : ''}`),
);
jest.mock('@/lib/i18n/server-messages', () => ({
    translateFor: (...a: unknown[]) => translateFor(...(a as [string, string])),
}));
const publishNotificationEvent = jest.fn();
jest.mock('@/lib/notifications/notification-bus', () => ({
    publishNotificationEvent: (...a: unknown[]) => publishNotificationEvent(...a),
}));
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) => cb(mockPrisma),
    withTenantDb: (_tenantId: string, cb: (db: unknown) => unknown) => cb(mockRecipientDb),
}));

import {
    blockExchangeParty,
    closeExchangeThread,
    unblockExchangeParty,
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
    enqueueEmail.mockReset();
    mockRecipientDb.tenantMembership.findMany.mockResolvedValue([
        { user: { id: 'usr_seller', email: 'seller@example.test', uiLanguage: 'bg' }, tenant: { slug: 'seller-farm' } },
    ]);
    mockRecipientDb.notification.create.mockReset();
    mockRecipientDb.notification.create.mockResolvedValue({
        id: 'ntf1', createdAt: new Date('2026-09-25T08:00:00.000Z'),
    });
    mockPrisma.exchangeBlock.findFirst.mockResolvedValue(null);
    mockPrisma.exchangeBlock.create.mockResolvedValue({ id: 'blk1' });
    mockPrisma.exchangeBlock.deleteMany.mockResolvedValue({ count: 1 });
    translateFor.mockClear();
    publishNotificationEvent.mockClear();
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

    it('does NOT refuse a closed thread — it reopens it', async () => {
        // The inverse of what this asserted while closing was unwired. A
        // refusal was harmless when nothing could set `closedAt`; now that
        // either party can close, refusing would let one side mute the other
        // permanently. See the "closing, and reopening by sending" block.
        mockPrisma.exchangeThread.findFirst.mockResolvedValue(thread({ closedAt: new Date() }));
        await expect(sendExchangeMessage(buyerCtx, 'th1', 'hello')).resolves.toMatchObject({
            reopened: true,
        });
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

describe('notifying the other side', () => {
    it('mails the OTHER party, not the sender', async () => {
        await sendExchangeMessage(buyerCtx, 'th1', 'hello');
        expect(enqueueEmail).toHaveBeenCalledTimes(1);
        const [, input] = enqueueEmail.mock.calls[0] as [unknown, Record<string, unknown>];
        expect(input.type).toBe('EXCHANGE_MESSAGE');
        expect(input.tenantId).toBe(SELLER);
    });

    it('dedupes on the THREAD, so a busy conversation is one mail a day', async () => {
        // `buildDedupeKey` composes tenant:type:email:entityId:DAY and skips a
        // duplicate silently. Keyed on the thread that is exactly right: ten
        // messages in an afternoon is a conversation, not ten emails.
        //
        // Asserted by NAME, not merely "some id" — keying this on the MESSAGE
        // would mail per message and read as spam, and the assertion below is
        // the only thing that would notice.
        await sendExchangeMessage(buyerCtx, 'th1', 'hello');
        const [, input] = enqueueEmail.mock.calls[0] as [unknown, Record<string, unknown>];
        expect(input.entityId).toBe('th1');
    });

    it("writes in the RECIPIENT's language, not the sender's", async () => {
        // The one Exchange channel that crosses a tenant boundary — the reader
        // is a different person from the writer.
        await sendExchangeMessage(buyerCtx, 'th1', 'hello');
        const [, input] = enqueueEmail.mock.calls[0] as [unknown, Record<string, unknown>];
        expect(input.locale).toBe('bg');
    });

    it('carries NO message preview', async () => {
        // Deliberate: the mail is deduped per day, so by the time it is read
        // there may be one new message or nine. Quoting one misrepresents the
        // conversation, and keeps private text in an inbox we do not control.
        await sendExchangeMessage(buyerCtx, 'th1', 'commercially sensitive');
        const [, input] = enqueueEmail.mock.calls[0] as [unknown, { payload: Record<string, unknown> }];
        expect(JSON.stringify(input.payload)).not.toContain('commercially sensitive');
    });

    it('a mail failure does NOT fail the send', async () => {
        // The message is already committed. Turning a successful send into an
        // error the sender sees would be the worst of both.
        enqueueEmail.mockRejectedValue(new Error('smtp down'));
        await expect(sendExchangeMessage(buyerCtx, 'th1', 'hello')).resolves.toBeDefined();
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


describe('the bell, one row per message', () => {
    it('writes a notification with NO dedupeKey — the point of the channel', async () => {
        await sendExchangeMessage(buyerCtx, 'th1', 'Имате ли още налично?');

        expect(mockRecipientDb.notification.create).toHaveBeenCalledTimes(1);
        const arg = mockRecipientDb.notification.create.mock.calls[0][0] as {
            data: Record<string, unknown>;
        };
        expect(arg.data.type).toBe('EXCHANGE_MESSAGE');
        expect(arg.data.userId).toBe('usr_seller');
        expect(arg.data.tenantId).toBe(SELLER);
        expect(arg.data.linkUrl).toBe('/t/seller-farm/exchange/threads/th1');
        // A dedupeKey here would re-create the exact bug this channel exists
        // to cover: the email already collapses to one per day.
        expect(arg.data.dedupeKey).toBeUndefined();
    });

    it('notifies on the SECOND message of the same day — the regression', async () => {
        await sendExchangeMessage(buyerCtx, 'th1', 'first');
        await sendExchangeMessage(buyerCtx, 'th1', 'second');

        // Before this channel existed, message two reached the recipient on no
        // channel at all: the outbox dedupe key ends in the UTC day and skips
        // silently.
        expect(mockRecipientDb.notification.create).toHaveBeenCalledTimes(2);
        expect(publishNotificationEvent).toHaveBeenCalledTimes(2);
    });

    it("renders the copy in the RECIPIENT's language, not the sender's", async () => {
        // 'en' DELIBERATELY, because RECIPIENT_FALLBACK_LOCALE is 'bg'. With a
        // 'bg' recipient this assertion has no teeth — "honoured uiLanguage"
        // and "silently used the fallback" produce identical output, and a
        // mutation replacing the lookup with the constant passed.
        mockRecipientDb.tenantMembership.findMany.mockResolvedValue([
            { user: { id: 'u_en', email: 'en@example.test', uiLanguage: 'en' }, tenant: { slug: 'seller-farm' } },
        ]);
        await sendExchangeMessage(buyerCtx, 'th1', 'hello');
        const arg = mockRecipientDb.notification.create.mock.calls[0][0] as {
            data: Record<string, unknown>;
        };
        expect(arg.data.title).toBe('en|notificationInApp.exchangeMessage.title');
        expect(arg.data.message).toContain('en|notificationInApp.exchangeMessage.body');
        expect(arg.data.message).toContain('wheat'); // the commodity, interpolated
    });

    it('falls back to Bulgarian when the recipient has no uiLanguage', async () => {
        mockRecipientDb.tenantMembership.findMany.mockResolvedValue([
            { user: { id: 'u2', email: 'x@example.test', uiLanguage: null }, tenant: { slug: 's' } },
        ]);
        await sendExchangeMessage(buyerCtx, 'th1', 'hello');
        const arg = mockRecipientDb.notification.create.mock.calls[0][0] as {
            data: Record<string, unknown>;
        };
        // The product's fallback, not the sender's language and not `null`.
        expect(arg.data.title).toBe('bg|notificationInApp.exchangeMessage.title');
    });

    it('persists BEFORE publishing — a subscriber must not outrun the row', async () => {
        const order: string[] = [];
        mockRecipientDb.notification.create.mockImplementation(async () => {
            order.push('create');
            return { id: 'ntf1', createdAt: new Date() };
        });
        publishNotificationEvent.mockImplementation(() => { order.push('publish'); });

        await sendExchangeMessage(buyerCtx, 'th1', 'hello');
        expect(order).toEqual(['create', 'publish']);
    });

    it('a failed bell write does not roll back the message', async () => {
        mockRecipientDb.notification.create.mockRejectedValue(new Error('db gone'));
        await expect(sendExchangeMessage(buyerCtx, 'th1', 'hello')).resolves.toBeDefined();
    });
});


describe('closing, and reopening by sending', () => {
    it('either party may close — the buyer', async () => {
        mockPrisma.exchangeThread.findFirst.mockResolvedValue({
            id: 'th1', listingId: 'lst1', inquirerTenantId: BUYER, closedAt: null,
            listing: { sellerTenantId: SELLER, commodity: 'wheat' },
        });
        const r = await closeExchangeThread(buyerCtx, 'th1');
        expect(r.alreadyClosed).toBe(false);
        expect(mockPrisma.exchangeThread.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ closedAt: expect.any(Date) }) }),
        );
    });

    it('either party may close — the seller', async () => {
        mockPrisma.exchangeThread.findFirst.mockResolvedValue({
            id: 'th1', listingId: 'lst1', inquirerTenantId: BUYER, closedAt: null,
            listing: { sellerTenantId: SELLER, commodity: 'wheat' },
        });
        // Symmetric on purpose: a seller-only close would let one side end a
        // negotiation the other cannot resume.
        await expect(closeExchangeThread(sellerCtx, 'th1')).resolves.toMatchObject({
            alreadyClosed: false,
        });
    });

    it('is idempotent — a second close keeps the ORIGINAL timestamp', async () => {
        const first = new Date('2026-09-20T10:00:00.000Z');
        mockPrisma.exchangeThread.findFirst.mockResolvedValue({
            id: 'th1', listingId: 'lst1', inquirerTenantId: BUYER, closedAt: first,
            listing: { sellerTenantId: SELLER, commodity: 'wheat' },
        });
        const r = await closeExchangeThread(buyerCtx, 'th1');
        expect(r).toEqual({ closedAt: first, alreadyClosed: true });
        // "When did this end" must not drift every time someone taps it.
        expect(mockPrisma.exchangeThread.update).not.toHaveBeenCalled();
    });

    it('sending on a CLOSED thread reopens it rather than refusing', async () => {
        mockPrisma.exchangeThread.findFirst.mockResolvedValue({
            id: 'th1', listingId: 'lst1', inquirerTenantId: BUYER,
            closedAt: new Date('2026-09-20T10:00:00.000Z'),
            listing: { sellerTenantId: SELLER, commodity: 'wheat' },
        });
        const r = await sendExchangeMessage(buyerCtx, 'th1', 'still interested?');
        expect(r.reopened).toBe(true);
        const [upd] = mockPrisma.exchangeThread.update.mock.calls.at(-1) as [
            { data: Record<string, unknown> },
        ];
        expect(upd.data.closedAt).toBeNull();
    });

    it('clears closedAt even on an OPEN thread, so a concurrent close cannot survive', async () => {
        const r = await sendExchangeMessage(buyerCtx, 'th1', 'hello');
        expect(r.reopened).toBe(false);
        const [upd] = mockPrisma.exchangeThread.update.mock.calls.at(-1) as [
            { data: Record<string, unknown> },
        ];
        // Unconditional: a close landing between the read and this write must
        // not outlive a message that came after it.
        expect(upd.data.closedAt).toBeNull();
    });
});


describe('a seller blocking a buyer', () => {
    it('the SELLER may block', async () => {
        await expect(blockExchangeParty(sellerCtx, 'th1')).resolves.toMatchObject({
            blocked: true, alreadyBlocked: false,
        });
        const [arg] = mockPrisma.exchangeBlock.create.mock.calls[0] as [
            { data: Record<string, unknown> },
        ];
        expect(arg.data.sellerTenantId).toBe(SELLER);
        expect(arg.data.blockedTenantId).toBe(BUYER);
    });

    it('the BUYER may not — there is no mirror control', async () => {
        await expect(blockExchangeParty(buyerCtx, 'th1')).rejects.toThrow(/seller/i);
        expect(mockPrisma.exchangeBlock.create).not.toHaveBeenCalled();
    });

    it('is idempotent — blocking twice is one row, not an error', async () => {
        mockPrisma.exchangeBlock.findFirst.mockResolvedValue({ id: 'blk1' });
        await expect(blockExchangeParty(sellerCtx, 'th1')).resolves.toMatchObject({
            alreadyBlocked: true,
        });
        expect(mockPrisma.exchangeBlock.create).not.toHaveBeenCalled();
    });

    it('refuses a blocked buyer OPENING a thread — including one they already had', async () => {
        mockPrisma.exchangeBlock.findFirst.mockResolvedValue({ id: 'blk1' });
        await expect(openExchangeThread(buyerCtx, 'lst1')).rejects.toThrow(/not accepting/i);
        // Checked before the idempotent read, so a pre-existing thread is not
        // handed back either.
        expect(mockPrisma.exchangeThread.create).not.toHaveBeenCalled();
    });

    it('refuses a blocked buyer SENDING', async () => {
        mockPrisma.exchangeBlock.findFirst.mockResolvedValue({ id: 'blk1' });
        await expect(sendExchangeMessage(buyerCtx, 'th1', 'hello')).rejects.toThrow(/not accepting/i);
        expect(mockPrisma.exchangeMessage.create).not.toHaveBeenCalled();
    });

    it('the SELLER can still write in a thread they blocked', async () => {
        mockPrisma.exchangeBlock.findFirst.mockResolvedValue({ id: 'blk1' });
        // "Stop them reaching me", not "freeze the record" — a symmetric
        // refusal would lock the seller out of their own conversation.
        await expect(sendExchangeMessage(sellerCtx, 'th1', 'final word')).resolves.toBeDefined();
        expect(mockPrisma.exchangeMessage.create).toHaveBeenCalled();
    });

    it('unblocking lifts it, and is not an error when there is nothing to lift', async () => {
        mockPrisma.exchangeBlock.deleteMany.mockResolvedValue({ count: 0 });
        await expect(unblockExchangeParty(sellerCtx, 'th1')).resolves.toEqual({ blocked: false });
    });

    it('the buyer may not unblock themselves', async () => {
        await expect(unblockExchangeParty(buyerCtx, 'th1')).rejects.toThrow(/seller/i);
        expect(mockPrisma.exchangeBlock.deleteMany).not.toHaveBeenCalled();
    });
});


describe('your own message must not light up your own badge', () => {
    it('sending moves the SENDER\'s read pointer', async () => {
        // The inbox's `hasUnread` is `lastMessageAt > readAt` and does not look
        // at who sent the last message. Without this, sending bumps
        // lastMessageAt past your own pointer and your own thread reports
        // unread — a badge that is wrong, which is worse than no badge,
        // especially on a phone that renders it as a count.
        await sendExchangeMessage(buyerCtx, 'th1', 'hello');
        const [upd] = mockPrisma.exchangeThread.update.mock.calls.at(-1) as [
            { data: Record<string, unknown> },
        ];
        expect(upd.data.inquirerLastReadAt).toBeInstanceOf(Date);
        // The OTHER party's pointer must not move — that would mark your
        // message read on their behalf.
        expect(upd.data.sellerLastReadAt).toBeUndefined();
    });

    it('the seller sending moves the seller pointer, not the buyer\'s', async () => {
        await sendExchangeMessage(sellerCtx, 'th1', 'yes, 40 tonnes');
        const [upd] = mockPrisma.exchangeThread.update.mock.calls.at(-1) as [
            { data: Record<string, unknown> },
        ];
        expect(upd.data.sellerLastReadAt).toBeInstanceOf(Date);
        expect(upd.data.inquirerLastReadAt).toBeUndefined();
    });
});
