/**
 * Where a quiet-hours summary push lands — #3074.
 *
 * The rule is the whole deliverable, and it is unobservable from the push: a
 * summary with no destination and a summary whose destination shows none of
 * its items look identical to the person tapping it. So it is a pure function
 * with its own table of cases, rather than something inferred from an
 * integration assertion about one night.
 *
 * ## What changed, and what expired
 *
 * The owner's 2026-11-14 ruling gave several items NO link because no surface
 * rendered several at once. «За Вас» (#3069) is now that surface, so the
 * premise expired — `a-safety-argument-expires-silently`.
 *
 * ## Why the COUNT is not the test
 *
 * «За Вас» renders channel replies and mentions and NO direct messages, so
 * `count > 1 → /channels/for-you` would land a night of two DMs on a page
 * showing neither — the same defect the original ruling avoided, one surface
 * over. The kinds decide. #3133 carries whether an all-DM night should get
 * `/exchange/threads`.
 */
import {
    FOR_YOU_KINDS,
    FOR_YOU_PATH,
    deferralPath,
    summaryPath,
} from '@/app-layer/jobs/person-push-summary';

const mention = (n: string) => ({
    kind: 'CHANNEL_MENTION',
    channelId: `ch-${n}`,
    postId: `po-${n}`,
    conversationId: null,
});
const dm = (n: string) => ({
    kind: 'DIRECT_MESSAGE',
    channelId: null,
    postId: null,
    conversationId: `cv-${n}`,
});

describe('summaryPath — one item', () => {
    it('lands on the POST, not on any aggregate', () => {
        // Strictly better than «За Вас» for a single item: the post itself.
        expect(summaryPath({ count: 1, offSurfaceCount: 0, first: mention('9') })).toBe(
            '/channels/ch-9/posts/po-9',
        );
    });

    it('lands on the DM thread when the one item is a direct message', () => {
        expect(summaryPath({ count: 1, offSurfaceCount: 1, first: dm('7') })).toBe(
            '/exchange/threads/dm/cv-7',
        );
    });

    it('is linkless for a single pre-#3020 row with no subject', () => {
        expect(
            summaryPath({
                count: 1,
                offSurfaceCount: 0,
                first: { kind: 'CHANNEL_MENTION', channelId: null, postId: null, conversationId: null },
            }),
        ).toBeNull();
    });
});

describe('summaryPath — several items', () => {
    it('links to «За Вас» when every held item is channel activity', () => {
        // The #3074 change. Before it this returned null.
        expect(summaryPath({ count: 2, offSurfaceCount: 0, first: mention('1') })).toBe(
            FOR_YOU_PATH,
        );
        expect(summaryPath({ count: 40, offSurfaceCount: 0, first: mention('1') })).toBe(
            FOR_YOU_PATH,
        );
    });

    it('stays LINKLESS for a mixed night', () => {
        // Nothing renders both populations, so there is no honest destination.
        expect(summaryPath({ count: 3, offSurfaceCount: 1, first: mention('1') })).toBeNull();
    });

    it('stays LINKLESS for a night of direct messages alone', () => {
        // The case that makes this kind-aware rather than count-based: «За
        // Вас» would show NONE of these. #3133 is the open question.
        expect(summaryPath({ count: 2, offSurfaceCount: 2, first: dm('1') })).toBeNull();
    });

    it('does not read the kinds off `first`', () => {
        // `first` comes from a `take: 2` read and cannot speak for row three.
        // A rule that trusted it would send two mentions plus a DM to a page
        // showing two of the three items — and the third is the one somebody
        // was waiting for. Same `first`, opposite verdicts.
        const withDm = summaryPath({ count: 3, offSurfaceCount: 1, first: mention('1') });
        const without = summaryPath({ count: 3, offSurfaceCount: 0, first: mention('1') });
        expect(withDm).toBeNull();
        expect(without).toBe(FOR_YOU_PATH);
    });
});

describe('summaryPath — the empty case', () => {
    it('is linkless, and never reaches `first`', () => {
        expect(summaryPath({ count: 0, offSurfaceCount: 0, first: null })).toBeNull();
    });
});

describe('FOR_YOU_KINDS is an allowlist', () => {
    it('names only what «За Вас» renders', () => {
        // An ALLOWLIST: a fourth `PersonPushDeferralKind` counts as
        // off-surface and suppresses the link until somebody decides that page
        // lists it. An open-ended `!== 'DIRECT_MESSAGE'` would enrol it
        // silently.
        expect([...FOR_YOU_KINDS].sort()).toEqual(['CHANNEL_MENTION', 'CHANNEL_REPLY']);
        expect(FOR_YOU_KINDS).not.toContain('DIRECT_MESSAGE');
    });

    it('CONTROL — the exported path is the live route segment', () => {
        // `person-push-link-resolves` grades this destination against the real
        // `(app)` page routes; this pins the constant the job sends so a typo
        // cannot pass by being absent from the scan.
        expect(FOR_YOU_PATH).toBe('/channels/for-you');
    });

    it('CONTROL — deferralPath still composes from the row pieces', () => {
        // Unchanged by #3074, asserted because `summaryPath` now stands in
        // front of it and a broken delegation would look like a rule change.
        expect(deferralPath(mention('3'))).toBe('/channels/ch-3/posts/po-3');
    });
});
