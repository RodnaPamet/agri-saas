/**
 * P9.3b — threads, mentions and «Решено», against a real database (#2937).
 *
 * ## Mentions are IDS, and the test that matters is the Cyrillic one
 *
 * There is no person handle in this product, so a mention cannot be parsed
 * from the body — and had it been, `/@\w+/` would have matched nothing in
 * `@Иван`, because JavaScript's `\b` and `\w` are ASCII-only. A parser would
 * have passed its English fixtures and mentioned nobody in Bulgarian.
 *
 * That is why the cases below use Cyrillic bodies with explicit ids: the body
 * carries display text and the ids carry the meaning, so the two cannot
 * disagree and no regex is involved.
 *
 * ## The SQL arm and the usecase bound different things
 *
 * `channel_post_mention_insert` (P9.3b's migration) bounds WHO may write a
 * mention — only a post's author. The cap of five is bounded HERE, because
 * counting the rows already inserted for a post is a query against the table
 * the policy guards.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    joinChannel, postToChannel, replyToPost, setQuestionResolved,
    readChannelFeed, CHANNEL_MENTION_MAX,
} from '@/app-layer/usecases/channels';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const AUTHOR = `u-p93b-author-${randomUUID()}`;
const MEMBER_A = `u-p93b-a-${randomUUID()}`;
const MEMBER_B = `u-p93b-b-${randomUUID()}`;
const OUTSIDER = `u-p93b-out-${randomUUID()}`;
let channelId = '';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

describeFn('P9.3b — threads, mentions and «Решено» (#2937)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: `crop:p93b-${randomUUID()}`, nameBg: 'Тест', nameEn: 'T', kind: 'CROP' },
            select: { id: true },
        });
        channelId = c.id;
        for (const u of [AUTHOR, MEMBER_A, MEMBER_B]) {
            await joinChannel(ctxFor(u), channelId);
        }
    });

    afterAll(async () => {
        await prisma.channel.deleteMany({ where: { id: channelId } });
        await prisma.$disconnect();
    });

    describe('mentions', () => {
        it('records a mention of a MEMBER, from a Cyrillic body', async () => {
            const res = await postToChannel(ctxFor(AUTHOR), channelId, {
                body: 'Иван, какво мислиш за сеитбата?',
                mentionUserIds: [MEMBER_A],
            });
            expect(res.mentionsRecorded).toBe(1);

            const rows = await prisma.channelPostMention.findMany({
                where: { postId: res.postId }, select: { userId: true },
            });
            expect(rows.map((r) => r.userId)).toEqual([MEMBER_A]);
        }, 60_000);

        it('DROPS a non-member rather than refusing the whole post', async () => {
            // A stale picker must not cost the operator their words.
            const res = await postToChannel(ctxFor(AUTHOR), channelId, {
                body: 'въпрос към всички',
                mentionUserIds: [MEMBER_A, OUTSIDER],
            });
            expect(res.mentionsRecorded).toBe(1);
            expect(res.postId).toBeTruthy();

            const rows = await prisma.channelPostMention.findMany({
                where: { postId: res.postId }, select: { userId: true },
            });
            expect(rows.map((r) => r.userId)).toEqual([MEMBER_A]);
        }, 60_000);

        it('DROPS a self-mention', async () => {
            const res = await postToChannel(ctxFor(AUTHOR), channelId, {
                body: 'бележка за себе си',
                mentionUserIds: [AUTHOR],
            });
            expect(res.mentionsRecorded).toBe(0);
        }, 60_000);

        it('counts a DUPLICATE once, so one name cannot push twice', async () => {
            const res = await postToChannel(ctxFor(AUTHOR), channelId, {
                body: 'Иван и пак Иван',
                mentionUserIds: [MEMBER_A, MEMBER_A],
            });
            expect(res.mentionsRecorded).toBe(1);
        }, 60_000);

        it('REFUSES more than five, rather than silently truncating', async () => {
            // Truncating would be the kinder-looking failure and the wrong one:
            // the operator believes they notified six people.
            const six = Array.from({ length: CHANNEL_MENTION_MAX + 1 }, () => `u-${randomUUID()}`);
            await expect(
                postToChannel(ctxFor(AUTHOR), channelId, { body: 'много', mentionUserIds: six }),
            ).rejects.toMatchObject({ code: 'CHANNEL_TOO_MANY_MENTIONS' });
        }, 60_000);

        it('a NON-AUTHOR cannot write a mention on somebody else’s post — the SQL arm', async () => {
            const post = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'моя публикация' });
            // Direct insert as another member, which is what the policy bounds.
            // A mention is a PUSH TRIGGER, so this is the hole P9.1 withheld the
            // arm for and P9.3b's WITH CHECK closes.
            const { runInUserContext } = await import('@/lib/db-context');
            let refused = '';
            try {
                await runInUserContext(ctxFor(MEMBER_B), (tx) =>
                    tx.$executeRawUnsafe(
                        `INSERT INTO "ChannelPostMention"("id","postId","userId") VALUES ($1,$2,$3)`,
                        `cm-${randomUUID()}`, post.postId, MEMBER_A,
                    ));
            } catch (e) {
                refused = e instanceof Error ? e.message : String(e);
            }
            expect(refused).toMatch(/row-level security|insufficient privilege|permission denied/i);

            const rows = await prisma.channelPostMention.count({ where: { postId: post.postId } });
            expect(rows).toBe(0);
        }, 60_000);
    });

    describe('threads', () => {
        it('a reply carries parentPostId and stays OUT of the top-level feed', async () => {
            const parent = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'родител' });
            const reply = await replyToPost(ctxFor(MEMBER_A), parent.postId, { body: 'отговор' });

            expect(reply.channelCopyPostId).toBeNull();

            const feed = await readChannelFeed(ctxFor(MEMBER_A), channelId, { limit: 100 });
            const ids = feed.posts.map((p) => p.id);
            expect(ids).toContain(parent.postId);
            // The feed filters `parentPostId: null`, so a reply must not appear.
            expect(ids).not.toContain(reply.postId);
        }, 60_000);

        it('«Също изпрати в канала» writes TWO rows, and the copy IS in the feed', async () => {
            const parent = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'родител 2' });
            const reply = await replyToPost(ctxFor(MEMBER_A), parent.postId, {
                body: 'и в канала', alsoToChannel: true,
            });
            expect(reply.channelCopyPostId).toBeTruthy();
            expect(reply.channelCopyPostId).not.toBe(reply.postId);

            const feed = await readChannelFeed(ctxFor(MEMBER_A), channelId, { limit: 100 });
            const ids = feed.posts.map((p) => p.id);
            expect(ids).toContain(reply.channelCopyPostId!);
            expect(ids).not.toContain(reply.postId);

            // Both carry the same body, and the copy is independently
            // moderatable — which is the point of two rows.
            const copy = await prisma.channelPost.findUniqueOrThrow({
                where: { id: reply.channelCopyPostId! },
                select: { body: true, parentPostId: true },
            });
            expect(copy.body).toBe('и в канала');
            expect(copy.parentPostId).toBeNull();
        }, 60_000);

        it('mentions go on the REPLY only, never on the channel copy', async () => {
            // Both rows would push twice for one act.
            const parent = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'родител 3' });
            const reply = await replyToPost(ctxFor(MEMBER_A), parent.postId, {
                body: 'виж това', alsoToChannel: true, mentionUserIds: [MEMBER_B],
            });
            expect(reply.mentionsRecorded).toBe(1);

            expect(await prisma.channelPostMention.count({
                where: { postId: reply.postId },
            })).toBe(1);
            expect(await prisma.channelPostMention.count({
                where: { postId: reply.channelCopyPostId! },
            })).toBe(0);
        }, 60_000);

        it('refuses a reply to a REPLY — threads are one level deep', async () => {
            const parent = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'родител 4' });
            const reply = await replyToPost(ctxFor(MEMBER_A), parent.postId, { body: 'отговор' });

            await expect(
                replyToPost(ctxFor(MEMBER_B), reply.postId, { body: 'отговор на отговор' }),
            ).rejects.toMatchObject({ code: 'CHANNEL_THREAD_TOO_DEEP' });
        }, 60_000);

        it('refuses a reply to a RETRACTED post', async () => {
            const parent = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'ще се изтрие' });
            await prisma.channelPost.update({
                where: { id: parent.postId }, data: { deletedAt: new Date() },
            });
            await expect(
                replyToPost(ctxFor(MEMBER_A), parent.postId, { body: 'късно' }),
            ).rejects.toMatchObject({ code: 'CHANNEL_POST_DELETED' });
        }, 60_000);

        it('a NON-MEMBER cannot reply, even to a post they can read', async () => {
            const parent = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'родител 5' });
            await expect(
                replyToPost(ctxFor(OUTSIDER), parent.postId, { body: 'здравейте' }),
            ).rejects.toMatchObject({ code: 'CHANNEL_NOT_A_MEMBER' });
        }, 60_000);
    });

    describe('«Въпрос» / «Решено»', () => {
        async function askQuestion(): Promise<string> {
            const res = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'Кога да сея?' });
            await prisma.channelPost.update({
                where: { id: res.postId }, data: { kind: 'QUESTION' },
            });
            return res.postId;
        }

        it('the ASKER may mark it resolved, and un-mark it', async () => {
            const id = await askQuestion();
            const on = await setQuestionResolved(ctxFor(AUTHOR), id, true);
            expect(on.resolvedAt).not.toBeNull();
            const off = await setQuestionResolved(ctxFor(AUTHOR), id, false);
            expect(off.resolvedAt).toBeNull();
        }, 60_000);

        it('ANOTHER member may not — 403, not the 404 a missing post gives', async () => {
            // The caller can SEE the post, because the feed is public, so
            // pretending it is absent would contradict what they are looking at.
            const id = await askQuestion();
            await expect(
                setQuestionResolved(ctxFor(MEMBER_A), id, true),
            ).rejects.toMatchObject({ code: 'CHANNEL_NOT_THE_ASKER' });
        }, 60_000);

        it('a plain POST cannot be marked resolved', async () => {
            const res = await postToChannel(ctxFor(AUTHOR), channelId, { body: 'не е въпрос' });
            await expect(
                setQuestionResolved(ctxFor(AUTHOR), res.postId, true),
            ).rejects.toMatchObject({ code: 'CHANNEL_NOT_A_QUESTION' });
        }, 60_000);
    });
});
