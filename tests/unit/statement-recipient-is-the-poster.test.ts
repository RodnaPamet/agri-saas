/**
 * A statement about CONTENT goes to the member who posted it (#1690).
 *
 * ## The ruling, and why the alternative was rejected
 *
 * Owner ruling: **the member who posted it** — the person whose act was
 * judged. The alternative, the farm's owner, would tell an owner about a
 * colleague's moderated content, which is close to what P5.2b decided a social
 * block must never reveal and is the way #1656 was decided.
 *
 * ## THREE kinds resolve, and the split is inherited not invented
 *
 * This said "two of four" until #2955. `CHANNEL_POST` was added by P9.3c
 * (#2937) and the sentence was not, which is the reason the arm sat untested
 * here: the prisma mock below carried no `channelPost`, so a call for that kind
 * threw on `undefined.findUnique`, the function's own catch swallowed it, and
 * the result was `null` — indistinguishable from a kind that has no arm. A
 * green suite about an arm it never reached.
 *
 *   LISTING        `ExchangeListing.sellerUserId`
 *   MESSAGE        `ExchangeMessage.senderUserId`
 *   CHANNEL_POST   `ChannelPost.authorUserId` (P9.3c)
 *   PROFILE        the removable surface is P6's `FarmBrand`; not this
 *   THREAD         a thread is not POSTED — two parties, and the seller side
 *                  deliberately has no column ("it is `listing.sellerUserId`"),
 *                  so "the member who posted it" has no referent
 *   DIRECT_MESSAGE reportable and NOT removable (owner ruling 2026-11-08), so
 *                  there is no removal to explain
 *
 * The failure this guards against is the one that makes a statement worse than
 * no statement: addressing a legal communication about somebody's content to a
 * person who did not post it.
 */
const listingFindUnique = jest.fn();
const messageFindUnique = jest.fn();
const channelPostFindUnique = jest.fn();
const models = () => ({
    exchangeListing: { findUnique: (...a: unknown[]) => listingFindUnique(...a) },
    exchangeMessage: { findUnique: (...a: unknown[]) => messageFindUnique(...a) },
    // ADDED BY #2955. Its absence is why the `CHANNEL_POST` arm was green and
    // unreached — see the docblock.
    channelPost: { findUnique: (...a: unknown[]) => channelPostFindUnique(...a) },
});
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: models(),
    prisma: models(),
}));

const warn = jest.fn();
const info = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: (...a: unknown[]) => warn(...a),
        info: (...a: unknown[]) => info(...a),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

import { resolveContentRecipient } from '@/app-layer/usecases/statement-queue';

beforeEach(() => {
    jest.clearAllMocks();
    listingFindUnique.mockResolvedValue({ sellerUserId: 'u-seller' });
    messageFindUnique.mockResolvedValue({ senderUserId: 'u-sender' });
    channelPostFindUnique.mockResolvedValue({ authorUserId: 'u-author' });
});

describe('the content statement goes to the poster (#1690)', () => {
    it('LISTING resolves to the seller who posted it', async () => {
        await expect(resolveContentRecipient('LISTING', 'lst-1')).resolves.toBe('u-seller');
        // Resolved from the ROW, not from the request: `subjectId` is
        // reporter-supplied and `FileReportSchema` calls it opaque, so the
        // owner of the row is the only trustworthy answer.
        expect(listingFindUnique).toHaveBeenCalledWith({
            where: { id: 'lst-1' },
            select: { sellerUserId: true },
        });
    });

    it('MESSAGE resolves to the sender', async () => {
        await expect(resolveContentRecipient('MESSAGE', 'msg-1')).resolves.toBe('u-sender');
        expect(messageFindUnique).toHaveBeenCalledWith({
            where: { id: 'msg-1' },
            select: { senderUserId: true },
        });
    });

    it.each(['PROFILE', 'THREAD'])('%s resolves to NOBODY, deliberately', async (kind) => {
        await expect(resolveContentRecipient(kind, 'x-1')).resolves.toBeNull();
        // And it does not go looking: a kind with no poster must not resolve
        // through some other row and address a stranger.
        expect(listingFindUnique).not.toHaveBeenCalled();
        expect(messageFindUnique).not.toHaveBeenCalled();
    });

    it('CHANNEL_POST resolves to the author', async () => {
        await expect(resolveContentRecipient('CHANNEL_POST', 'cp-1')).resolves.toBe('u-author');
        expect(channelPostFindUnique).toHaveBeenCalledWith({
            where: { id: 'cp-1' },
            select: { authorUserId: true },
        });
    });

    it('a subjectId matching nothing resolves to nobody — and says so at WARN (#2955)', async () => {
        // A bogus or deleted id. No statement is still the correct OUTCOME —
        // the alternative is addressing one to whoever a fallback picked.
        //
        // What #2955 changes is that it is no longer SILENT. This is a kind we
        // support, so a null here means a removal that will never be explained,
        // and it used to be reached without a single log line — the same value
        // the designed `PROFILE`/`THREAD` path returns, so the two were
        // indistinguishable in any log search.
        listingFindUnique.mockResolvedValue(null);
        await expect(resolveContentRecipient('LISTING', 'lst-gone')).resolves.toBeNull();

        expect(warn).toHaveBeenCalledTimes(1);
        const [event, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
        expect(event).toBe('moderation.statement_recipient_row_missing');
        expect(fields.subjectKind).toBe('LISTING');
        // The id, because somebody has to be able to find which decision went
        // unexplained. A listing id, never a person and never body text.
        expect(fields.subjectId).toBe('lst-gone');
    });

    it('warns for EVERY supported kind whose row is gone, not just LISTING', async () => {
        // Three arms, three chances to forget. The first draft of #2955 wired
        // one and the suite would have passed.
        for (const [kind, id, mock] of [
            ['MESSAGE', 'msg-gone', messageFindUnique],
            ['CHANNEL_POST', 'cp-gone', channelPostFindUnique],
        ] as const) {
            warn.mockClear();
            (mock as jest.Mock).mockResolvedValue(null);
            await expect(resolveContentRecipient(kind, id)).resolves.toBeNull();
            expect(warn).toHaveBeenCalledTimes(1);
            expect((warn.mock.calls[0] as [string, Record<string, unknown>])[1].subjectKind)
                .toBe(kind);
        }
    });

    it('a DESIGNED recipientless kind does NOT warn — the control that makes the warn mean something', async () => {
        // `PROFILE` and `THREAD` return null by design and stay at `info`. If
        // they warned too, the warn would fire on the normal state and be worth
        // nothing — the same reasoning that keeps an unledgered E2E flake loud
        // and a ledgered one quiet.
        await expect(resolveContentRecipient('PROFILE', 'p-1')).resolves.toBeNull();
        await expect(resolveContentRecipient('THREAD', 't-1')).resolves.toBeNull();
        expect(warn).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalled();
    });

    it('a RESOLVED kind does not warn either', async () => {
        // The other direction: a warn on every call would satisfy the cases
        // above and make the signal useless.
        await expect(resolveContentRecipient('LISTING', 'lst-1')).resolves.toBe('u-seller');
        expect(warn).not.toHaveBeenCalled();
    });

    it('a lookup failure resolves to nobody rather than throwing', async () => {
        // This runs after the moderation transaction has committed. A failed
        // lookup must not undo a decision that is already recorded.
        listingFindUnique.mockRejectedValue(new Error('db down'));
        await expect(resolveContentRecipient('LISTING', 'lst-1')).resolves.toBeNull();
    });

    it('the two resolving kinds give DIFFERENT people — the control', async () => {
        // Without this, a resolver hardcoded to one id would satisfy both
        // positive cases and read as covered.
        const a = await resolveContentRecipient('LISTING', 'lst-1');
        const b = await resolveContentRecipient('MESSAGE', 'msg-1');
        expect(a).not.toBe(b);
        expect(a).toBeTruthy();
        expect(b).toBeTruthy();
    });

    it('an unknown kind resolves to nobody, not to a default', async () => {
        // A fifth `ReportSubjectKind` added later must not silently inherit
        // one of these two tables.
        await expect(resolveContentRecipient('SOMETHING_NEW', 'x-1')).resolves.toBeNull();
        expect(listingFindUnique).not.toHaveBeenCalled();
        expect(messageFindUnique).not.toHaveBeenCalled();
    });
});
