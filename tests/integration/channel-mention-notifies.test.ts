/**
 * A channel mention and a reply TELL somebody — #2987, against a real database.
 *
 * ## What was wrong, and why every check was green
 *
 * `recordMentions` was the only writer of `ChannelPostMention`; the GDPR
 * export was the only reader. So a mention's sole observable effect was that
 * it appeared in the mentioned person's Art 15 download, possibly months
 * later — and three docblocks described a push that did not exist, one of them
 * a SECURITY argument and one of them `mutedAt`'s, a column no writer touched.
 *
 * Nothing failed, because a missing notification is not a route, no copy was
 * absent (none is composed), and the behavioural suites asserted that the ROW
 * was written — which was true. `p9-3b-threads-mentions` is green throughout
 * and stays green; this file asks the question that one does not.
 *
 * ## It OBSERVES the bus rather than asserting about source
 *
 * `REDIS_URL` is deliberately unset in the test job (`ci.yml` sets
 * `REDIS_URL_TEST` instead, so the suite exercises the graceful-degradation
 * path), which puts the bus in its IN-PROCESS mode: a publish is delivered
 * synchronously to subscribers in this process. So the test subscribes and
 * counts real deliveries instead of grepping for a call.
 *
 * That mode is asserted as a PRECONDITION. Without it, a suite that silently
 * ran against Redis would see every delivery arrive asynchronously, assert
 * zero, and report the feature broken — or, with the assertions written the
 * other way round, report it working while delivering nothing.
 *
 * ## Every zero is paired with a positive, in the same test where possible
 *
 * P8.1's three `REFUSES …` cases all passed while the rule enforced nothing.
 * Here the shape to guard against is subtler: "nobody was notified" is what a
 * BROKEN publisher produces and also what a correctly-suppressed mute
 * produces, so each suppression case notifies somebody else in the same post.
 */
/**
 * `enqueue` is the ONE mock in this file, and it is mocked rather than driven
 * because the alternative is a live BullMQ: `.env.test` sets no `REDIS_URL`,
 * so a real enqueue would fail and the push half would be untestable here.
 * Capturing the payload is also the stronger assertion — what matters is WHAT
 * is enqueued (the recipient, the copy, the collapse key), not that a queue
 * accepted it, and `tests/unit/jobs/person-push-send.test.ts` covers the other
 * side of that boundary.
 */
const enqueueMock = jest.fn().mockResolvedValue(undefined);
jest.mock('@/app-layer/jobs/queue', () => ({
    __esModule: true,
    enqueue: (...a: unknown[]) => enqueueMock(...a),
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { joinChannel, postToChannel, replyToPost } from '@/app-layer/usecases/channels';
import {
    subscribeToChannelActivity,
    subscribeToPersonEvents,
    getNotificationBusMode,
    __resetNotificationBusForTests,
    type NotificationEvent,
} from '@/lib/notifications/notification-bus';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const AUTHOR = `u-2987-author-${randomUUID()}`;
const MENTIONED = `u-2987-mentioned-${randomUUID()}`;
const MUTED = `u-2987-muted-${randomUUID()}`;
const BANNED = `u-2987-banned-${randomUUID()}`;
const LEAVER = `u-2987-leaver-${randomUUID()}`;
/** Posts first, is banned after — the only path that reaches the ban check. */
const BANNED_LATER = `u-2987-banned-later-${randomUUID()}`;
let channelId = '';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/** Everything delivered to one person's channel-activity address this test. */
function listen(userId: string): { got: NotificationEvent[]; stop: () => void } {
    const got: NotificationEvent[] = [];
    const stop = subscribeToChannelActivity({ userId, send: (e) => got.push(e) });
    return { got, stop };
}

describeFn('#2987 — a mention and a reply notify somebody', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: {
                key: `crop:p2987-${randomUUID()}`,
                nameBg: 'Тест', nameEn: 'T', kind: 'CROP',
            },
            select: { id: true },
        });
        channelId = c.id;
        for (const u of [AUTHOR, MENTIONED, MUTED, BANNED, LEAVER, BANNED_LATER]) {
            await joinChannel(ctxFor(u), channelId);
        }
        // Muting and banning have no writer in the app yet — #2990 owns the
        // read cursor and the mute control, and a ban is P9.3's moderation
        // path. Set directly, which is what makes the COLUMN the subject here
        // rather than some future endpoint.
        await prisma.channelMembership.update({
            where: { channelId_userId: { channelId, userId: MUTED } },
            data: { mutedAt: new Date() },
        });
        await prisma.channelMembership.update({
            where: { channelId_userId: { channelId, userId: BANNED } },
            data: { bannedAt: new Date() },
        });
    }, 120_000);

    afterAll(async () => {
        await prisma.channel.deleteMany({ where: { id: channelId } });
        await prisma.$disconnect();
    });

    beforeEach(() => {
        __resetNotificationBusForTests();
        enqueueMock.mockClear();
    });

    /** Every `person-push-send` payload enqueued for one person. */
    const pushesFor = (userId: string) =>
        enqueueMock.mock.calls
            .filter((c) => c[0] === 'person-push-send')
            .map((c) => c[1] as Record<string, unknown>)
            .filter((p) => p.recipientUserId === userId);

    it('the bus is IN-PROCESS, so a publish is observable here', () => {
        // The precondition every count below rests on. Asserted rather than
        // assumed: against Redis the deliveries would be asynchronous and
        // every assertion in this file would be measuring the wrong thing.
        expect(getNotificationBusMode()).toBe('in-process');
    });

    describe('a mention', () => {
        it('reaches the mentioned member, carrying the CHANNEL id', async () => {
            const them = listen(MENTIONED);
            try {
                await postToChannel(ctxFor(AUTHOR), channelId, {
                    body: 'Иван, какво мислиш за сеитбата?',
                    mentionUserIds: [MENTIONED],
                });
                // The channel, not the post: a client given a post id would
                // still have to work out which channel to put it in.
                expect(them.got).toEqual([{ id: channelId }]);
            } finally {
                them.stop();
            }
        }, 60_000);

        it('does NOT reach the author of the post', async () => {
            const me = listen(AUTHOR);
            const them = listen(MENTIONED);
            try {
                await postToChannel(ctxFor(AUTHOR), channelId, {
                    body: 'питам всички',
                    mentionUserIds: [MENTIONED],
                });
                // The pairing that makes the zero mean something: the same
                // post DID notify somebody.
                expect(them.got).toHaveLength(1);
                expect(me.got).toHaveLength(0);
            } finally {
                me.stop();
                them.stop();
            }
        }, 60_000);

        it('does NOT reach a MUTED member — and the mention ROW is still written', async () => {
            // The distinction the whole design turns on. The row is a RECORD
            // and is what the Art 15 export returns; the mute is a statement
            // about being interrupted. Filtering at the mention would make a
            // muted person's mention vanish from their own data download.
            const muted = listen(MUTED);
            const heard = listen(MENTIONED);
            try {
                const res = await postToChannel(ctxFor(AUTHOR), channelId, {
                    body: 'двама от вас',
                    mentionUserIds: [MUTED, MENTIONED],
                });
                expect(res.mentionsRecorded).toBe(2);

                const rows = await prisma.channelPostMention.findMany({
                    where: { postId: res.postId },
                    select: { userId: true },
                });
                expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([MUTED, MENTIONED]));

                expect(heard.got).toHaveLength(1);
                expect(muted.got).toHaveLength(0);
            } finally {
                muted.stop();
                heard.stop();
            }
        }, 60_000);

        it('does NOT reach a BANNED member, who cannot be mentioned at all', async () => {
            // Two layers agreeing: `resolveMentionable` already drops a banned
            // member, so there is no row AND no event. Asserted together
            // because a change to either alone would leave the other looking
            // like the reason.
            const banned = listen(BANNED);
            const heard = listen(MENTIONED);
            try {
                const res = await postToChannel(ctxFor(AUTHOR), channelId, {
                    body: 'и двамата',
                    mentionUserIds: [BANNED, MENTIONED],
                });
                expect(res.mentionsRecorded).toBe(1);
                expect(heard.got).toHaveLength(1);
                expect(banned.got).toHaveLength(0);
            } finally {
                banned.stop();
                heard.stop();
            }
        }, 60_000);

        it('does NOT arrive on the DM address', async () => {
            // The two are different SSE frame kinds, so a crossover is not a
            // lost event — it is a client opening a conversation whose id is a
            // channel's.
            const dm: NotificationEvent[] = [];
            const stopDm = subscribeToPersonEvents({ userId: MENTIONED, send: (e) => dm.push(e) });
            const channel = listen(MENTIONED);
            try {
                await postToChannel(ctxFor(AUTHOR), channelId, {
                    body: 'само канал',
                    mentionUserIds: [MENTIONED],
                });
                expect(channel.got).toHaveLength(1);
                expect(dm).toHaveLength(0);
            } finally {
                stopDm();
                channel.stop();
            }
        }, 60_000);
    });

    describe('a reply', () => {
        it("reaches the PARENT post's author", async () => {
            const parent = await postToChannel(ctxFor(MENTIONED), channelId, {
                body: 'моят въпрос',
                kind: 'QUESTION',
            });
            const asker = listen(MENTIONED);
            try {
                await replyToPost(ctxFor(AUTHOR), parent.postId, { body: 'ето отговор' });
                // THE case the owner's ruling turns on: a «Въпрос» answered in
                // a channel used to notify nobody, so it was seen only by
                // whoever scrolled past.
                expect(asker.got).toEqual([{ id: channelId }]);
            } finally {
                asker.stop();
            }
        }, 60_000);

        it('notifies ONCE when it also MENTIONS the parent author', async () => {
            // Two causes, one act.
            //
            // What makes it one event is NOT the `Set` in `reachableTargets` —
            // measured: removing it left this case green, because the publish
            // iterates the ROWS of a `findMany` and there is one membership
            // row per person per channel. So `in: [x, x]` yields one row.
            //
            // This assertion is kept on the OUTCOME for exactly that reason:
            // it does not name a mechanism, so it still fails if a later
            // change publishes per candidate instead of per row.
            const parent = await postToChannel(ctxFor(MENTIONED), channelId, {
                body: 'въпрос втори',
                kind: 'QUESTION',
            });
            const asker = listen(MENTIONED);
            try {
                await replyToPost(ctxFor(AUTHOR), parent.postId, {
                    body: 'Иване, ето',
                    mentionUserIds: [MENTIONED],
                });
                expect(asker.got).toHaveLength(1);
            } finally {
                asker.stop();
            }
        }, 60_000);

        it('tells nobody when the author replies to their OWN post', async () => {
            const parent = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'моя тема' });
            const me = listen(AUTHOR);
            const heard = listen(MENTIONED);
            try {
                await replyToPost(ctxFor(AUTHOR), parent.postId, {
                    body: 'допълвам себе си',
                    mentionUserIds: [MENTIONED],
                });
                expect(me.got).toHaveLength(0);
                // The positive control: the mention in the same reply landed.
                expect(heard.got).toHaveLength(1);
            } finally {
                me.stop();
                heard.stop();
            }
        }, 60_000);

        it('tells a BANNED parent author nothing, though they may still read', async () => {
            // This case exists because of a surviving mutation. The banned
            // MENTION case above is settled entirely by `resolveMentionable`,
            // which drops a banned member before any row is written — so
            // removing `bannedAt: null` from `reachableTargets` changed
            // nothing and the suite stayed green.
            //
            // A reply target is the one path that reaches the ban check here:
            // the person POSTED while unbanned, so there is no mention to
            // filter and the membership row is the only thing that can refuse.
            const parent = await postToChannel(ctxFor(BANNED_LATER), channelId, {
                body: 'преди забраната',
            });
            await prisma.channelMembership.update({
                where: { channelId_userId: { channelId, userId: BANNED_LATER } },
                data: { bannedAt: new Date() },
            });
            const banned = listen(BANNED_LATER);
            const heard = listen(MENTIONED);
            try {
                await replyToPost(ctxFor(AUTHOR), parent.postId, {
                    body: 'отговор след забраната',
                    mentionUserIds: [MENTIONED],
                });
                expect(banned.got).toHaveLength(0);
                // Same reply, somebody notified — so the zero is the ban and
                // not a publisher that stopped working.
                expect(heard.got).toHaveLength(1);
            } finally {
                banned.stop();
                heard.stop();
            }
        }, 60_000);

        it('tells a parent author who has LEFT the channel nothing', async () => {
            // Leaving discards `lastReadAt` and `mutedAt` — P9.5, where
            // rejoining writes a FRESH row — so there is no preference left to
            // honour, and the absence of a row is read as "not interested in
            // this channel" rather than as a reason to invent one.
            const parent = await postToChannel(ctxFor(LEAVER), channelId, { body: 'преди да изляза' });
            await prisma.channelMembership.delete({
                where: { channelId_userId: { channelId, userId: LEAVER } },
            });
            const gone = listen(LEAVER);
            const heard = listen(MENTIONED);
            try {
                await replyToPost(ctxFor(AUTHOR), parent.postId, {
                    body: 'отговор след излизане',
                    mentionUserIds: [MENTIONED],
                });
                expect(gone.got).toHaveLength(0);
                // Same post, somebody notified — so the zero is a suppression
                // and not a broken publisher.
                expect(heard.got).toHaveLength(1);
            } finally {
                gone.stop();
                heard.stop();
            }
        }, 60_000);
    });

    describe('the after-commit ordering', () => {
        it('a post that ROLLS BACK AT COMMIT notifies nobody', async () => {
            // The property `after-commit.ts` exists for, and the one this
            // suite could not otherwise see: `afterCommit` fires IMMEDIATELY
            // when no scope is open, so every other case here would pass
            // identically whether the publish were deferred or inline. Only a
            // rollback separates the two.
            //
            // The failure has to land AFTER the callback has queued its
            // effect, i.e. at COMMIT — a statement error inside the body would
            // abort before anything was queued and this would pass vacuously.
            // There are no SAVEPOINTs in `src/`, so the instrument is a
            // `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, which is
            // `exchange-notify-after-commit`'s technique one domain over.
            //
            // It keys on the BODY, which that test could not do: an
            // `ExchangeMessage` body is stored encrypted (the `'*'` fan-out
            // encrypts any field named `body`), so a trigger comparing
            // plaintext never matched and its first version passed its send
            // and failed its assertion. `ChannelPost.body` is deliberately
            // PLAINTEXT — P9.1, so P9.7 can search it — so here the plain
            // comparison is the right instrument.
            const ROLLBACK_BODY = 'това съобщение не бива да съществува';
            await prisma.$executeRawUnsafe(`
                CREATE OR REPLACE FUNCTION p2987_force_rollback() RETURNS trigger AS $fn$
                BEGIN
                    IF NEW."body" = '${ROLLBACK_BODY}' THEN
                        RAISE EXCEPTION 'forced rollback at COMMIT';
                    END IF;
                    RETURN NULL;
                END
                $fn$ LANGUAGE plpgsql
            `);
            await prisma.$executeRawUnsafe(`
                CREATE CONSTRAINT TRIGGER p2987_force_rollback_trg
                    AFTER INSERT ON "ChannelPost"
                    DEFERRABLE INITIALLY DEFERRED
                    FOR EACH ROW EXECUTE FUNCTION p2987_force_rollback()
            `);

            const them = listen(MENTIONED);
            try {
                await expect(
                    postToChannel(ctxFor(AUTHOR), channelId, {
                        body: ROLLBACK_BODY,
                        mentionUserIds: [MENTIONED],
                    }),
                ).rejects.toThrow(/forced rollback at COMMIT/);

                // The post is gone — proof the rollback really happened rather
                // than the trigger merely raising a notice. Without this the
                // zero below is also what a trigger that aborted early
                // produces.
                const posts = await prisma.channelPost.count({
                    where: { channelId, body: ROLLBACK_BODY },
                });
                expect(posts).toBe(0);

                expect(them.got).toEqual([]);
            } finally {
                them.stop();
                await prisma.$executeRawUnsafe(
                    `DROP TRIGGER IF EXISTS p2987_force_rollback_trg ON "ChannelPost"`,
                );
                await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS p2987_force_rollback()`);
            }
        }, 120_000);

        it('and the SAME flow with no trigger DOES notify — the control', async () => {
            // Three zeroes are also what a broken fixture produces. This runs
            // the identical call with the trigger gone, so the case above is a
            // statement about the rollback rather than about this suite.
            const them = listen(MENTIONED);
            try {
                const res = await postToChannel(ctxFor(AUTHOR), channelId, {
                    body: 'това съобщение бива да съществува',
                    mentionUserIds: [MENTIONED],
                });
                expect(res.mentionsRecorded).toBe(1);
                expect(them.got).toEqual([{ id: channelId }]);
            } finally {
                them.stop();
            }
        }, 60_000);
    });

    describe('the background push — #2987 PR B', () => {
        it('a MENTION enqueues one job naming the CHANNEL, in the recipient\u2019s language', async () => {
            await postToChannel(ctxFor(AUTHOR), channelId, {
                body: 'Иване, какво мислиш?',
                mentionUserIds: [MENTIONED],
            });

            const [push] = pushesFor(MENTIONED);
            expect(push).toBeDefined();
            // `uiLanguage` defaults to `bg`, so the copy is Bulgarian — the
            // RECIPIENT's language, not the author's. An English body here
            // would mean `getTranslations()` had resolved a request cookie.
            expect(push.title).toBe('Споменаха Ви');
            // The channel NAME is in the body and the POST is not. That is the
            // 2026-11-01 ruling ("keep the KEY, drop the free text"), and it
            // matters here more than for a task: `ChannelPost.body` is
            // PLAINTEXT at rest, so nothing but this stops a farmer's prose
            // reaching Apple.
            expect(push.body).toContain('Тест');
            expect(push.body).not.toContain('Иване, какво мислиш?');
            // The PATH, not the link: a channel has no farm, so
            // `person-push-send` resolves the recipient's and prefixes
            // `/t/{slug}`. #2932 is what a bare path cost.
            expect(push.farmRelativePath).toBe(`/channels/${channelId}`);
            expect(push.collapseKey).toBe(`channel-${channelId}-mention`);
        }, 60_000);

        it('a REPLY enqueues the REPLY copy, not the mention copy', async () => {
            const parent = await postToChannel(ctxFor(MENTIONED), channelId, {
                body: 'моят въпрос',
                kind: 'QUESTION',
            });
            enqueueMock.mockClear();

            await replyToPost(ctxFor(AUTHOR), parent.postId, { body: 'ето отговор' });

            const [push] = pushesFor(MENTIONED);
            expect(push).toBeDefined();
            expect(push.title).toBe('Нов отговор');
            expect(push.collapseKey).toBe(`channel-${channelId}-reply`);
        }, 60_000);

        it('a reply that ALSO mentions its parent author pushes ONCE, as a MENTION', async () => {
            // Two causes, one act — and the mention wins because it is the more
            // specific description. Asserted on the COUNT and on which copy,
            // because "one push" alone would be satisfied by either.
            const parent = await postToChannel(ctxFor(MENTIONED), channelId, {
                body: 'въпрос втори',
                kind: 'QUESTION',
            });
            enqueueMock.mockClear();

            await replyToPost(ctxFor(AUTHOR), parent.postId, {
                body: 'Иване, ето',
                mentionUserIds: [MENTIONED],
            });

            const pushes = pushesFor(MENTIONED);
            expect(pushes).toHaveLength(1);
            expect(pushes[0].title).toBe('Споменаха Ви');
        }, 60_000);

        it('a MUTED member gets no job — the mute suppresses the push too', async () => {
            const heard = listen(MENTIONED);
            try {
                await postToChannel(ctxFor(AUTHOR), channelId, {
                    body: 'двама от вас',
                    mentionUserIds: [MUTED, MENTIONED],
                });
                expect(pushesFor(MUTED)).toHaveLength(0);
                // The pairing: the same post DID enqueue for somebody, so the
                // zero is the mute rather than a broken caller.
                expect(pushesFor(MENTIONED)).toHaveLength(1);
                expect(heard.got).toHaveLength(1);
            } finally {
                heard.stop();
            }
        }, 60_000);

        it('an ordinary post enqueues NOTHING', async () => {
            const res = await postToChannel(ctxFor(AUTHOR), channelId, {
                body: 'просто споделям',
            });
            expect(res.postId).toBeTruthy();
            expect(enqueueMock.mock.calls.filter((c) => c[0] === 'person-push-send'))
                .toHaveLength(0);
        }, 60_000);
    });

    describe('an ordinary post mentioning nobody', () => {
        it('notifies NOBODY — a channel is not a broadcast list', async () => {
            // P9.3 notifies for mentions and replies and nothing else.
            // Notifying every member would make a 2,000-member crop channel
            // reachable by anybody who joined it.
            const a = listen(MENTIONED);
            const b = listen(MUTED);
            try {
                const res = await postToChannel(ctxFor(AUTHOR), channelId, {
                    body: 'просто споделям',
                });
                // The control that the post HAPPENED, so the two zeros are not
                // a failed write.
                expect(res.postId).toBeTruthy();
                expect(a.got).toHaveLength(0);
                expect(b.got).toHaveLength(0);
            } finally {
                a.stop();
                b.stop();
            }
        }, 60_000);
    });
});
