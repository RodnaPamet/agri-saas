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
    // #1298 — per-person read pointers live in their own table now. `markReadFor`
    // tries `updateMany` first (monotonic: only if the stored pointer is older)
    // and falls back to `create`, so both need to exist or every send throws.
    exchangeThreadRead: { updateMany: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
    exchangeMessage: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
    exchangeBlock: { findFirst: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
    // #1348 — `getExchangeThread` resolves a display name for every sender in
    // the page. Without this the whole suite throws on `user.findMany` of
    // undefined, which is a mock gap rather than a behaviour change.
    user: { findMany: jest.fn() },
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
// Both fakes wrap `runWithAfterCommit`, because the REAL helpers do (see
// `src/lib/db-context.ts`). Without it an `afterCommit(...)` inside a usecase
// finds no scope and fires immediately as an unawaited promise — so the notify
// assertions below would run before the effect had, and read as "it never
// notified". `require` inside the factory because `jest.mock` is hoisted above
// the imports.
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) =>
        (require('@/lib/db/after-commit') as typeof import('@/lib/db/after-commit'))
            .runWithAfterCommit(async () => cb(mockPrisma)),
    withTenantDb: (_tenantId: string, cb: (db: unknown) => unknown) =>
        (require('@/lib/db/after-commit') as typeof import('@/lib/db/after-commit'))
            .runWithAfterCommit(async () => cb(mockRecipientDb)),
}));

import {
    blockExchangeParty,
    closeExchangeThread,
    listExchangeThreads,
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

/**
 * #1298 — the userId is a PARAMETER, and the two sides are two PEOPLE.
 *
 * This hardcoded `usr_1` for both, so `buyerCtx` and `sellerCtx` were the same
 * person at different tenants. Harmless while `mine` compared farms; fatal to
 * a per-person test, where it made every message the caller's own on BOTH
 * sides — the `mine` case below failed on exactly that before it was fixed.
 */
function ctxFor(tenantId: string, userId: string) {
    return {
        requestId: 'r', userId, tenantId, tenantSlug: 'acme', role: 'EDITOR',
        permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false },
        appPermissions: {},
    } as unknown as RequestContext;
}
const buyerCtx = ctxFor(BUYER, 'usr_buyer');
const sellerCtx = ctxFor(SELLER, 'usr_seller');

function thread(over: Record<string, unknown> = {}) {
    return {
        id: 'th1', listingId: 'lst1', inquirerTenantId: BUYER,
        // #1298 — the buyer-side principal. `ctx.userId` is `usr_1` in this
        // file, so the default fixture makes the caller the principal; a case
        // that wants a NON-principal overrides it.
        inquirerUserId: 'usr_buyer',
        lastMessageAt: new Date('2026-09-01T10:00:00Z'), closedAt: null,
        // The CALLER's own read pointer, as a relation filtered to them. The
        // two `*LastReadAt` columns this replaces are gone from the select —
        // `requireParty` reads `thread.reads[0]`, deliberately without a `?.`:
        // an absent `reads` means the select lost it, and defaulting to null
        // would silently mean "never read", i.e. every message unread.
        reads: [] as Array<{ lastReadAt: Date }>,
        listing: { sellerTenantId: SELLER, sellerUserId: 'usr_seller', commodity: 'wheat' },
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.exchangeThread.findFirst.mockResolvedValue(thread());
    // A pointer that moved: `markReadFor` returns early and never reaches
    // `create`, which is the common path and keeps these cases about what
    // they are actually testing.
    mockPrisma.exchangeThreadRead.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.exchangeThreadRead.create.mockResolvedValue({ id: 'etr1' });
    mockPrisma.user.findMany.mockResolvedValue([]);
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
    // Reset, not just re-seed: `mockResolvedValue` persists across tests, so a
    // message fixture set by one test satisfied another's idempotency replay
    // check and the result depended on execution ORDER.
    mockPrisma.exchangeMessage.findFirst.mockReset();
    mockPrisma.exchangeMessage.findFirst.mockResolvedValue(null);
    mockPrisma.exchangeMessage.create.mockReset();
    mockPrisma.exchangeMessage.create.mockResolvedValue({
        id: 'msg_new', createdAt: new Date('2026-09-25T09:30:00.000Z'),
    });
    mockPrisma.exchangeMessage.count.mockResolvedValue(0);
    mockPrisma.exchangeBlock.findFirst.mockResolvedValue(null);
    mockPrisma.exchangeBlock.create.mockResolvedValue({ id: 'blk1' });
    mockPrisma.exchangeBlock.deleteMany.mockResolvedValue({ count: 1 });
    translateFor.mockClear();
    publishNotificationEvent.mockClear();
});

describe('opening a thread', () => {
    it('is idempotent — a second tap returns the SAME thread', async () => {
        mockPrisma.exchangeThread.findFirst.mockResolvedValue({ id: 'th1', reads: [] });
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

describe('the read pointer is monotonic, and PER PERSON', () => {
    it('does NOT move backwards when a stale request arrives late', async () => {
        // The failure this prevents: two tabs, the older one answering second,
        // the pointer rewinding, and already-read messages going unread again.
        //
        // #1298 — the pointer is now the CALLER's own row, so the stale case is
        // "the stored value is already ahead of `now`" and `markReadFor`'s
        // conditional `updateMany` matches nothing. It then tries `create`,
        // which the unique on (threadId, userId) refuses, and the refusal is
        // swallowed because the loser's value is never newer.
        const future = new Date(Date.now() + 60_000);
        mockPrisma.exchangeThread.findFirst.mockResolvedValue(
            thread({ reads: [{ lastReadAt: future }] }),
        );
        const r = await markExchangeThreadRead(buyerCtx, 'th1');
        expect(r.readAt).toBe(future);
        // Not a single write attempt: the early return happens before them.
        expect(mockPrisma.exchangeThreadRead.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.exchangeThreadRead.create).not.toHaveBeenCalled();
    });

    it('moves the pointer forward on a normal read', async () => {
        // The positive control — without it, a function that never wrote
        // anything would satisfy the assertion above.
        await markExchangeThreadRead(buyerCtx, 'th1');
        expect(mockPrisma.exchangeThreadRead.updateMany).toHaveBeenCalled();
    });

    it('moves the CALLER own pointer — not their side, and never the thread row', async () => {
        // This case used to assert `sellerLastReadAt` was set and
        // `inquirerLastReadAt` was not. Both columns are gone from the write
        // path: they were ONE PER SIDE, so any member of a farm reading marked
        // the thread read for all of them, which is half of what #1298 fixes.
        await markExchangeThreadRead(sellerCtx, 'th1');

        const where = mockPrisma.exchangeThreadRead.updateMany.mock.calls[0][0].where;
        expect(where.threadId).toBe('th1');
        // The SELLER's own user id, from their context — not a side token.
        expect(where.userId).toBe(sellerCtx.userId);
        // And monotonic: only a pointer strictly older than `now` moves.
        expect(where.lastReadAt).toHaveProperty('lt');

        // The thread row itself is untouched by a read.
        expect(mockPrisma.exchangeThread.update).not.toHaveBeenCalled();
    });
});

describe('a malformed ?limit= cannot reach Prisma as NaN', () => {
    /**
     * `?limit=abc` returned 500. The route did `limitRaw ? Number(limitRaw) :
     * undefined`, and NaN then survived everything that looks like a guard:
     *
     *     NaN ?? DEFAULT_PAGE_SIZE  -> NaN   (`??` catches null/undefined only)
     *     Math.max(NaN, 1)          -> NaN
     *     Math.min(NaN, 100)        -> NaN
     *     take: NaN + 1             -> NaN   -> Prisma rejects -> 500
     *
     * The routes now 400 on a value they cannot read (`parseLimitParam`), and
     * the clamp here is the choke point that stops a future caller
     * reintroducing it. These assert the CLAMP, by the `take` it produces.
     */
    it('the scrollback: NaN falls back to the default, not to take: NaN', async () => {
        await getExchangeThread(buyerCtx, 'th1', { limit: Number.NaN });
        const args = mockPrisma.exchangeMessage.findMany.mock.calls.at(-1)![0];
        expect(Number.isFinite(args.take)).toBe(true);
        expect(args.take).toBe(101); // DEFAULT_PAGE_SIZE + 1
    });

    it('the thread list: NaN falls back to the default too', async () => {
        // The shared beforeEach only stubs `exchangeMessage.findMany`; this
        // path reads threads, and an unstubbed mock returns undefined.
        mockPrisma.exchangeThread.findMany.mockResolvedValue([]);
        await listExchangeThreads(buyerCtx, { limit: Number.NaN });
        const args = mockPrisma.exchangeThread.findMany.mock.calls.at(-1)![0];
        expect(Number.isFinite(args.take)).toBe(true);
        expect(args.take).toBe(101);
    });

    it.each([
        ['Infinity', Number.POSITIVE_INFINITY, 101],
        ['a huge finite number', 1e9, 101],
        ['zero', 0, 2],
        ['a negative', -5, 2],
        ['a normal value', 5, 6],
    ])('%s clamps into range', async (_label, limit, expected) => {
        await getExchangeThread(buyerCtx, 'th1', { limit: limit as number });
        const args = mockPrisma.exchangeMessage.findMany.mock.calls.at(-1)![0];
        expect(args.take).toBe(expected);
    });

    it('control: an ABSENT limit produces the default, and 5 does NOT', async () => {
        // Without a control the assertions above are satisfied by a clamp
        // that ignores its argument and always returns the default. This
        // pins that the argument is read: two inputs, two takes.
        await getExchangeThread(buyerCtx, 'th1');
        const absent = mockPrisma.exchangeMessage.findMany.mock.calls.at(-1)![0].take;
        await getExchangeThread(buyerCtx, 'th1', { limit: 5 });
        const given = mockPrisma.exchangeMessage.findMany.mock.calls.at(-1)![0].take;
        expect(absent).toBe(101);
        expect(given).toBe(6);
        expect(given).not.toBe(absent);
    });
});

describe('the scrollback', () => {
    it('SELECTS newest-first, so a long thread returns its end', async () => {
        await getExchangeThread(buyerCtx, 'th1');
        const args = mockPrisma.exchangeMessage.findMany.mock.calls[0][0];
        // The `id` tiebreak is not decoration: `createdAt` alone is not a
        // total order, so two messages sharing a timestamp straddle a page
        // boundary and one is dropped while the other repeats.
        expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
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
        // #1298 — `mine` is "sent by ME", the person. It meant "sent by my
        // FARM", which rendered a colleague's message as the reader's own, so
        // these rows carry a sender USER and the contexts are two people.
        mockPrisma.exchangeMessage.findMany.mockResolvedValue([
            {
                id: 'a', senderTenantId: BUYER, senderUserId: buyerCtx.userId,
                body: 'hi', deletedAt: null, createdAt: new Date(),
            },
            {
                id: 'b', senderTenantId: SELLER, senderUserId: sellerCtx.userId,
                body: 'hello', deletedAt: null, createdAt: new Date(),
            },
            // A COLLEAGUE at the buyer farm: same tenant, different person.
            // Under the old farm-based rule this was indistinguishable from
            // the buyer's own message, which is the defect in one row.
            {
                id: 'c', senderTenantId: BUYER, senderUserId: 'usr_buyer_colleague',
                body: 'me too', deletedAt: null, createdAt: new Date(),
            },
        ]);
        const asBuyer = await getExchangeThread(buyerCtx, 'th1');
        expect(asBuyer.messages.find((m) => m.id === 'a')?.mine).toBe(true);
        expect(asBuyer.messages.find((m) => m.id === 'b')?.mine).toBe(false);
        // THE DISCRIMINATOR: not mine, but from my farm — a third speaker the
        // client has to label, and the one the old `mine` got wrong.
        const colleague = asBuyer.messages.find((m) => m.id === 'c');
        expect(colleague?.mine).toBe(false);
        expect(colleague?.fromMyFarm).toBe(true);

        const asSeller = await getExchangeThread(sellerCtx, 'th1');
        expect(asSeller.messages.find((m) => m.id === 'a')?.mine).toBe(false);
        expect(asSeller.messages.find((m) => m.id === 'b')?.mine).toBe(true);
        // The buyer's colleague is neither the seller's own nor their farm's.
        expect(asSeller.messages.find((m) => m.id === 'c')?.fromMyFarm).toBe(false);
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

    it('counts unread in the DATABASE, not over the fetched page', async () => {
        // This used to filter the fetched rows, which capped the badge at the
        // page size: a thread with more unread messages than one page reported
        // the page size and called it a count. With pagination that stops being
        // a corner case, so the count is a real query now.
        mockPrisma.exchangeMessage.count.mockResolvedValue(137);
        const r = await getExchangeThread(sellerCtx, 'th1');
        expect(r.unreadCount).toBe(137);

        const [arg] = mockPrisma.exchangeMessage.count.mock.calls[0] as [
            { where: Record<string, unknown> },
        ];
        expect(arg.where).toMatchObject({
            threadId: 'th1',
            // #1298 — "not mine" by PERSON. `{ not: ctx.tenantId }` counted a
            // colleague's message as unread for them and hid their own from a
            // count they should see.
            senderUserId: { not: sellerCtx.userId },
            // Never your own, and never a tombstone.
            deletedAt: null,
        });
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
        await expect(
            // A stranger FARM and a stranger PERSON: under #1298 either alone
            // would do, and naming both keeps the case about being party to
            // neither side rather than about which half was wrong.
            sendExchangeMessage(ctxFor('tnt_stranger', 'usr_stranger'), 'th1', 'hi'),
        )
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
            // #1298 — the gate is per PERSON now: the function always said
            // "only what they sent" while comparing the FARM, which would let
            // a colleague retract someone else's words.
            id: 'm1', senderTenantId: BUYER, senderUserId: buyerCtx.userId,
            threadId: 'th1', deletedAt: null,
        });
        await deleteExchangeMessage(buyerCtx, 'm1');
        const { data } = mockPrisma.exchangeMessage.update.mock.calls[0][0];
        expect(data.deletedAt).toBeInstanceOf(Date);
    });

    it('retracting twice is not an error', async () => {
        mockPrisma.exchangeMessage.findFirst.mockResolvedValue({
            // #1298 — the gate is per PERSON now: the function always said
            // "only what they sent" while comparing the FARM, which would let
            // a colleague retract someone else's words.
            id: 'm1', senderTenantId: BUYER, senderUserId: buyerCtx.userId,
            threadId: 'th1', deletedAt: new Date(),
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


describe('every sender in a thread is named (#1348)', () => {
    /**
     * Threads went per-person in #1323, which created two gaps a client could
     * not close: a seller sees several threads from one farm and cannot tell
     * them apart, and a colleague bubble (`fromMyFarm && !mine`) has no
     * speaker. The owner ruled that the NAME is shown rather than an anonymous
     * per-thread label — recorded on #1348, with the trade.
     */
    beforeEach(() => {
        mockPrisma.exchangeMessage.findMany.mockResolvedValue([
            { id: 'm1', senderTenantId: BUYER, senderUserId: 'usr_buyer', body: 'hi', deletedAt: null, createdAt: new Date('2026-01-01') },
            { id: 'm2', senderTenantId: SELLER, senderUserId: 'usr_seller', body: 'hello', deletedAt: null, createdAt: new Date('2026-01-02') },
            { id: 'm3', senderTenantId: SELLER, senderUserId: 'usr_colleague', body: 'me too', deletedAt: null, createdAt: new Date('2026-01-03') },
        ]);
        mockPrisma.user.findMany.mockResolvedValue([
            { id: 'usr_buyer', name: 'Иван Петров' },
            { id: 'usr_seller', name: 'Мария Георгиева' },
            { id: 'usr_colleague', name: null },
        ]);
    });

    it('names the OTHER party and a COLLEAGUE, from one lookup', async () => {
        const r = await getExchangeThread(sellerCtx, 'th1');
        const by = Object.fromEntries(r.messages.map((m) => [m.id, m.senderName]));
        // The buyer: the other farm's person, which is the disclosure the
        // owner approved and the whole reason sibling threads can be told
        // apart at all.
        expect(by.m1).toBe('Иван Петров');
        // A colleague at the caller's own farm — item 1 of #1348.
        expect(by.m2).toBe('Мария Георгиева');
    });

    it('a user with no name is NULL, not an empty string', async () => {
        // A client must be able to tell "no name set" from "named with
        // nothing" so it can render a fallback rather than a blank speaker.
        const r = await getExchangeThread(sellerCtx, 'th1');
        expect(r.messages.find((m) => m.id === 'm3')!.senderName).toBeNull();
    });

    it('the lookup is scoped to THIS thread\'s senders — not a directory read', async () => {
        // `User` has no tenantId and no RLS policy, so an unbounded query here
        // would read strangers. The id set must come from the page the caller
        // is already entitled to see.
        await getExchangeThread(sellerCtx, 'th1');
        const args = mockPrisma.user.findMany.mock.calls.at(-1)![0];
        expect(args.where.id.in.sort()).toEqual(['usr_buyer', 'usr_colleague', 'usr_seller']);
        // And it selects only what it needs — never the whole user row.
        expect(args.select).toEqual({ id: true, name: true });
    });

    it('asks for each sender ONCE, however many messages they sent', async () => {
        // Three messages, three senders. A page where one person sent fifty
        // must not produce fifty ids.
        await getExchangeThread(sellerCtx, 'th1');
        const ids = mockPrisma.user.findMany.mock.calls.at(-1)![0].where.id.in;
        expect(ids).toHaveLength(new Set(ids).size);
    });
});


describe('closing, and reopening by sending', () => {
    it('either party may close — the buyer', async () => {
        mockPrisma.exchangeThread.findFirst.mockResolvedValue({
            id: 'th1', listingId: 'lst1', inquirerTenantId: BUYER, inquirerUserId: 'usr_buyer', reads: [], closedAt: null,
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
            id: 'th1', listingId: 'lst1', inquirerTenantId: BUYER, inquirerUserId: 'usr_buyer', reads: [], closedAt: null,
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
            id: 'th1', listingId: 'lst1', inquirerTenantId: BUYER, inquirerUserId: 'usr_buyer', reads: [], closedAt: first,
            listing: { sellerTenantId: SELLER, commodity: 'wheat' },
        });
        const r = await closeExchangeThread(buyerCtx, 'th1');
        expect(r).toEqual({ closedAt: first, alreadyClosed: true });
        // "When did this end" must not drift every time someone taps it.
        expect(mockPrisma.exchangeThread.update).not.toHaveBeenCalled();
    });

    it('sending on a CLOSED thread reopens it rather than refusing', async () => {
        mockPrisma.exchangeThread.findFirst.mockResolvedValue({
            id: 'th1', listingId: 'lst1', inquirerTenantId: BUYER, inquirerUserId: 'usr_buyer', reads: [],
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
        // The PERSON, not their farm (#1314). Asserting the user id rather
        // than the tenant is the whole content of that change: blocking a
        // buyer must not silence colleagues who never wrote to this seller.
        expect(arg.data.blockedUserId).toBe('usr_buyer');
        expect(arg.data).not.toHaveProperty('blockedTenantId');
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


describe('pagination', () => {
    const iso = (d: string) => new Date(d);

    function threadRows(n: number, sameTimestamp = false) {
        return Array.from({ length: n }, (_, i) => ({
            id: `th${String(i).padStart(3, '0')}`,
            listingId: 'lst1',
            inquirerTenantId: BUYER,
            // #1298 — the inbox is per PERSON: the row carries its principal
            // and the CALLER's own read pointer as a filtered relation.
            inquirerUserId: 'usr_buyer',
            reads: [] as Array<{ lastReadAt: Date }>,
            lastMessageAt: sameTimestamp
                ? iso('2026-09-25T10:00:00.000Z')
                : iso(`2026-09-25T10:${String(59 - i).padStart(2, '0')}:00.000Z`),
            closedAt: null,
            sellerLastReadAt: null,
            inquirerLastReadAt: null,
            listing: {
                sellerTenantId: SELLER, commodity: 'wheat',
                regionName: 'Plovdiv', quantityTonnes: { toString: () => '100.000' },
                sellerDisplayName: null,
            },
        }));
    }

    it('asks for one more row than requested, to know if there is a next page', async () => {
        mockPrisma.exchangeThread.findMany.mockResolvedValue(threadRows(3));
        await listExchangeThreads(buyerCtx, { limit: 5 });
        const [args] = mockPrisma.exchangeThread.findMany.mock.calls.at(-1) as [
            { take: number; orderBy: unknown },
        ];
        expect(args.take).toBe(6);
        // Total order, same reason as the scrollback.
        expect(args.orderBy).toEqual([{ lastMessageAt: 'desc' }, { id: 'desc' }]);
    });

    it('a FULL final page does not advertise a next page', async () => {
        // The trap: deciding on `page.length < limit` says "there is more"
        // whenever the last page happens to be exactly full, and the client
        // then fetches an empty page. The extra row is what settles it.
        mockPrisma.exchangeThread.findMany.mockResolvedValue(threadRows(5));
        const r = await listExchangeThreads(buyerCtx, { limit: 5 });
        expect(r.threads).toHaveLength(5);
        expect(r.nextCursor).toBeNull();
    });

    it('returns a cursor when there IS more, and trims the extra row', async () => {
        mockPrisma.exchangeThread.findMany.mockResolvedValue(threadRows(6));
        const r = await listExchangeThreads(buyerCtx, { limit: 5 });
        expect(r.threads).toHaveLength(5);
        expect(r.nextCursor).toEqual(expect.any(String));
    });

    it('the cursor names ONE row even when timestamps tie', async () => {
        // The whole reason the id is in the cursor. With five threads sharing a
        // `lastMessageAt`, a cursor carrying only the timestamp cannot say
        // which one the page ended on — the next page either repeats all five
        // or skips them.
        mockPrisma.exchangeThread.findMany.mockResolvedValue(threadRows(6, true));
        const r = await listExchangeThreads(buyerCtx, { limit: 5 });
        const decoded = Buffer.from(String(r.nextCursor), 'base64url').toString('utf8');
        expect(decoded).toContain('|th004');

        // And feeding it back produces a keyset predicate, not a bare `lt`.
        await listExchangeThreads(buyerCtx, { limit: 5, cursor: r.nextCursor });
        const [args] = mockPrisma.exchangeThread.findMany.mock.calls.at(-1) as [
            { where: { OR?: unknown[] } },
        ];
        expect(args.where?.OR).toHaveLength(2);
    });

    it('a garbage cursor restarts the listing rather than 500ing', async () => {
        // A stale or truncated cursor is a client bug, not a server error, and
        // an Invalid Date would otherwise build a filter matching zero rows —
        // which reads as "no more pages" rather than as a fault.
        mockPrisma.exchangeThread.findMany.mockResolvedValue(threadRows(2));
        const r = await listExchangeThreads(buyerCtx, { cursor: 'not-a-cursor' });
        expect(r.threads).toHaveLength(2);
        const [args] = mockPrisma.exchangeThread.findMany.mock.calls.at(-1) as [
            { where: unknown },
        ];
        expect(args.where).toBeUndefined();
    });

    it('caps an absurd limit instead of honouring it', async () => {
        mockPrisma.exchangeThread.findMany.mockResolvedValue(threadRows(1));
        await listExchangeThreads(buyerCtx, { limit: 100000 });
        const [args] = mockPrisma.exchangeThread.findMany.mock.calls.at(-1) as [{ take: number }];
        expect(args.take).toBeLessThanOrEqual(101);
    });
});


describe('Idempotency-Key on send', () => {
    it('a replay returns the ORIGINAL message and says so', async () => {
        mockPrisma.exchangeMessage.findFirst.mockResolvedValue({
            id: 'msg_original', createdAt: new Date('2026-09-25T09:00:00.000Z'),
        });
        const r = await sendExchangeMessage(buyerCtx, 'th1', 'hello', 'key-1');
        expect(r).toMatchObject({ id: 'msg_original', replayed: true });
        // Nothing new is written.
        expect(mockPrisma.exchangeMessage.create).not.toHaveBeenCalled();
    });

    it('a first send is NOT flagged as a replay', async () => {
        // The distinction the iOS client asked to be named: a replay that looks
        // identical to a create is a shape nobody can branch on.
        const r = await sendExchangeMessage(buyerCtx, 'th1', 'hello', 'key-1');
        expect(r.replayed).toBe(false);
        const [arg] = mockPrisma.exchangeMessage.create.mock.calls.at(-1) as [
            { data: Record<string, unknown> },
        ];
        expect(arg.data.clientMutationId).toBe('key-1');
    });

    it('without a key nothing is stored and no lookup happens', async () => {
        await sendExchangeMessage(buyerCtx, 'th1', 'hello');
        const [arg] = mockPrisma.exchangeMessage.create.mock.calls.at(-1) as [
            { data: Record<string, unknown> },
        ];
        expect(arg.data.clientMutationId).toBeNull();
    });

    it('a replay wins even when the sender has since been BLOCKED', async () => {
        // The ordering that matters. If the block check ran first, a retry of a
        // message that was already delivered would 403 — telling the client its
        // message failed when it is sitting in the thread.
        mockPrisma.exchangeBlock.findFirst.mockResolvedValue({ id: 'blk1' });
        mockPrisma.exchangeMessage.findFirst.mockResolvedValue({
            id: 'msg_original', createdAt: new Date('2026-09-25T09:00:00.000Z'),
        });
        await expect(sendExchangeMessage(buyerCtx, 'th1', 'hello', 'key-1'))
            .resolves.toMatchObject({ id: 'msg_original', replayed: true });
    });

    it('a lost race re-reads the winner instead of surfacing a 500', async () => {
        // Both retries clear the replay check, then one loses the unique index.
        // A REAL PrismaClientKnownRequestError: `isUniqueViolation` checks
        // `instanceof`, so a plain object carrying `code: 'P2002'` sails past
        // the backstop and the test fails for the wrong reason.
        const { Prisma } = jest.requireActual('@prisma/client');
        const p2002 = new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002', clientVersion: 'test',
        });
        mockPrisma.exchangeMessage.findFirst
            .mockResolvedValueOnce(null)   // replay check: nothing yet
            .mockResolvedValueOnce({ id: 'msg_winner', createdAt: new Date() });
        mockPrisma.exchangeMessage.create.mockRejectedValueOnce(p2002);
        await expect(sendExchangeMessage(buyerCtx, 'th1', 'hello', 'key-1'))
            .resolves.toMatchObject({ id: 'msg_winner', replayed: true });
    });
});

describe('your own message must not light up your own badge', () => {
    it('sending moves the SENDER\'s read pointer', async () => {
        // The inbox's `hasUnread` is `lastMessageAt > readAt` and does not look
        // at who sent the last message. Without this, sending bumps
        // lastMessageAt past your own pointer and your own thread reports
        // unread — a badge that is wrong, which is worse than no badge,
        // especially on a phone that renders it as a count.
        //
        // #1298 — the pointer moved is the SENDER's own row, not their side's
        // column. The old form marked the thread read for every member of the
        // sender's farm, so a colleague's badge cleared because you replied.
        await sendExchangeMessage(buyerCtx, 'th1', 'hello');

        const where = mockPrisma.exchangeThreadRead.updateMany.mock.calls.at(-1)![0].where;
        expect(where.userId).toBe(buyerCtx.userId);
        expect(where.threadId).toBe('th1');

        // The OTHER party's pointer must not move — that would mark your
        // message read on their behalf. Now structural rather than asserted:
        // every write is scoped to ONE userId, so there is no shape in which a
        // send can touch someone else's. Pinned anyway, because "scoped by
        // construction" is exactly the kind of claim that stops being true.
        const writes = mockPrisma.exchangeThreadRead.updateMany.mock.calls
            .concat(mockPrisma.exchangeThreadRead.create.mock.calls)
            .map((c: unknown[]) => (c[0] as { where?: { userId?: string }; data?: { userId?: string } }))
            .map((a) => a.where?.userId ?? a.data?.userId);
        expect(writes.length).toBeGreaterThan(0);
        expect(writes.every((u) => u === buyerCtx.userId)).toBe(true);

        // And the thread row carries no read pointer any more.
        const [upd] = mockPrisma.exchangeThread.update.mock.calls.at(-1) as [
            { data: Record<string, unknown> },
        ];
        expect(upd.data.inquirerLastReadAt).toBeUndefined();
        expect(upd.data.sellerLastReadAt).toBeUndefined();
    });

    it('the seller sending moves the seller pointer, not the buyer\'s', async () => {
        // Was: assert the thread row's `sellerLastReadAt` moved and
        // `inquirerLastReadAt` did not. Both columns left the write path with
        // #1298 — they were ONE PER SIDE, so a send marked the thread read for
        // every member of the sender's farm. The pointer is the sender's own
        // row now.
        await sendExchangeMessage(sellerCtx, 'th1', 'yes, 40 tonnes');
        const where = mockPrisma.exchangeThreadRead.updateMany.mock.calls.at(-1)![0].where;
        expect(where.userId).toBe(sellerCtx.userId);
        expect(where.threadId).toBe('th1');
        // The thread row is still updated — for `lastMessageAt` — but carries
        // no read pointer any more.
        const [upd] = mockPrisma.exchangeThread.update.mock.calls.at(-1) as [
            { data: Record<string, unknown> },
        ];
        expect(upd.data.lastMessageAt).toBeInstanceOf(Date);
        expect(upd.data.sellerLastReadAt).toBeUndefined();
        expect(upd.data.inquirerLastReadAt).toBeUndefined();
    });
});


describe('the inbox row identifies its listing', () => {
    function row(over: Record<string, unknown> = {}) {
        return [{
            id: 'th1', listingId: 'l1', inquirerTenantId: BUYER, inquirerUserId: 'usr_buyer', reads: [],
            lastMessageAt: new Date('2026-09-25T10:00:00.000Z'),
            closedAt: null, sellerLastReadAt: null, inquirerLastReadAt: null,
            listing: {
                sellerTenantId: SELLER, commodity: 'wheat',
                regionName: 'Plovdiv',
                quantityTonnes: { toString: () => '100.000' },
                sellerDisplayName: 'Acme Farm',
                ...over,
            },
        }];
    }

    it('carries region and tonnage, so two wheat listings differ', async () => {
        mockPrisma.exchangeThread.findMany.mockResolvedValue(row());
        const r = await listExchangeThreads(buyerCtx);
        expect(r.threads[0]).toMatchObject({
            listingCommodity: 'wheat',
            listingRegionName: 'Plovdiv',
            listingQuantityTonnes: '100.000',
        });
    });

    it('keeps the tonnage a STRING, not a float', async () => {
        // The column is Decimal(14,3); a float loses the third place.
        mockPrisma.exchangeThread.findMany.mockResolvedValue(row());
        const r = await listExchangeThreads(buyerCtx);
        expect(typeof r.threads[0].listingQuantityTonnes).toBe('string');
    });

    it('exposes the SELLER name when published, and null when not', async () => {
        mockPrisma.exchangeThread.findMany.mockResolvedValue(row());
        expect((await listExchangeThreads(buyerCtx)).threads[0].sellerDisplayName).toBe('Acme Farm');

        mockPrisma.exchangeThread.findMany.mockResolvedValue(row({ sellerDisplayName: null }));
        expect((await listExchangeThreads(buyerCtx)).threads[0].sellerDisplayName).toBeNull();
    });

    it('never exposes the BUYER — that is behind the contact-reveal gate', async () => {
        // On a SELLER's row the counterparty is a buyer. Their identity is
        // only shared once the seller accepts an inquiry, so nothing naming
        // them may appear here.
        mockPrisma.exchangeThread.findMany.mockResolvedValue(row());
        const r = await listExchangeThreads(sellerCtx);
        const keys = Object.keys(r.threads[0]);
        expect(keys).not.toContain('inquirerDisplayName');
        expect(keys).not.toContain('counterpartyName');
        expect(JSON.stringify(r.threads[0])).not.toContain(BUYER);
    });
});
