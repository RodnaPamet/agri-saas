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
 * ## Two of four kinds resolve, and that split is inherited not invented
 *
 * `captureReportSnapshot` already treats the same two as unsupported, for
 * reasons that apply here unchanged:
 *
 *   LISTING   `ExchangeListing.sellerUserId`
 *   MESSAGE   `ExchangeMessage.senderUserId`
 *   PROFILE   the surface arrives with P6; it does not exist
 *   THREAD    a thread is not POSTED — two parties, and the seller side
 *             deliberately has no column ("it is `listing.sellerUserId`"), so
 *             "the member who posted it" has no referent
 *
 * The failure this guards against is the one that makes a statement worse than
 * no statement: addressing a legal communication about somebody's content to a
 * person who did not post it.
 */
const listingFindUnique = jest.fn();
const messageFindUnique = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        exchangeListing: { findUnique: (...a: unknown[]) => listingFindUnique(...a) },
        exchangeMessage: { findUnique: (...a: unknown[]) => messageFindUnique(...a) },
    },
    prisma: {
        exchangeListing: { findUnique: (...a: unknown[]) => listingFindUnique(...a) },
        exchangeMessage: { findUnique: (...a: unknown[]) => messageFindUnique(...a) },
    },
}));

import { resolveContentRecipient } from '@/app-layer/usecases/statement-queue';

beforeEach(() => {
    jest.clearAllMocks();
    listingFindUnique.mockResolvedValue({ sellerUserId: 'u-seller' });
    messageFindUnique.mockResolvedValue({ senderUserId: 'u-sender' });
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

    it('a subjectId matching nothing resolves to nobody', async () => {
        // A bogus or deleted id. No statement is the correct outcome — the
        // alternative is addressing one to whoever a fallback picked.
        listingFindUnique.mockResolvedValue(null);
        await expect(resolveContentRecipient('LISTING', 'lst-gone')).resolves.toBeNull();
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
