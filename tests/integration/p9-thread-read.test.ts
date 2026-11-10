/**
 * A channel thread can be READ, and «Решено» is observable — #2961.
 *
 * ## The defect
 *
 * `replyToPost` shipped in P9.3b with no reader. `readChannelFeed` filters
 * `parentPostId: null` — correctly, since one row cannot be both a reply and a
 * top-level post — and nothing else returned a reply, so a reply was written
 * to a row NO read path served. The author posted it into silence. The only
 * escape was `alsoToChannel`, which writes a second top-level row.
 *
 * `setQuestionResolved` had the same shape one field over: it wrote
 * `resolvedAt` and `ChannelPostView` had no such field, so a resolved question
 * was byte-identical to an open one through every read path.
 *
 * ## Why P9.3b was green
 *
 * Its case is named *"a reply carries parentPostId and stays OUT of the
 * top-level feed"* and asserts exactly that — `expect(ids).not.toContain(...)`.
 * True, and right about the property it names. Nothing asserted a reply was
 * READABLE, because nothing existed that could read one: the absence sat in
 * the test's own stated purpose, which is what made it invisible.
 *
 * So the first assertion here is the one nobody could have written before: a
 * reply comes back.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    joinChannel, postToChannel, replyToPost, setQuestionResolved,
    readChannelFeed, readPostReplies,
} from '@/app-layer/usecases/channels';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const ASKER = `u-p9tr-asker-${randomUUID()}`;
const MEMBER = `u-p9tr-member-${randomUUID()}`;
/** Never joins, to prove a thread is as public as the feed. */
const OUTSIDER = `u-p9tr-outsider-${randomUUID()}`;
let channelId = '';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

describeFn('#2961 — a thread is readable, and resolved state is visible', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: `crop:p9tr-${randomUUID()}`, nameBg: 'Нишка', nameEn: 'Thread', kind: 'CROP' },
            select: { id: true },
        });
        channelId = c.id;
        await joinChannel(ctxFor(ASKER), channelId);
        await joinChannel(ctxFor(MEMBER), channelId);
    });

    afterAll(async () => {
        await prisma.channelPostMention.deleteMany({ where: { post: { channelId } } });
        await prisma.channelPost.deleteMany({ where: { channelId, parentPostId: { not: null } } });
        await prisma.channelPost.deleteMany({ where: { channelId } });
        await prisma.channelMembership.deleteMany({ where: { channelId } });
        await prisma.channel.deleteMany({ where: { id: channelId } });
        await prisma.$disconnect();
    });

    it('returns a reply — the thing nothing could do before', async () => {
        const parent = await postToChannel(ctxFor(ASKER), channelId, { body: 'родител' });
        const reply = await replyToPost(ctxFor(MEMBER), parent.postId, { body: 'отговор' });

        const thread = await readPostReplies(ctxFor(MEMBER), parent.postId, {});
        expect(thread.replies.map((r) => r.id)).toEqual([reply.postId]);
        expect(thread.replies[0]!.body).toBe('отговор');
        expect(thread.replies[0]!.authorUserId).toBe(MEMBER);
        expect(thread.hasMore).toBe(false);
    }, 60_000);

    it('reads OLDEST first — a thread is a conversation, not a feed', async () => {
        const parent = await postToChannel(ctxFor(ASKER), channelId, { body: 'ред' });
        const first = await replyToPost(ctxFor(MEMBER), parent.postId, { body: 'първи' });
        const second = await replyToPost(ctxFor(MEMBER), parent.postId, { body: 'втори' });
        const third = await replyToPost(ctxFor(MEMBER), parent.postId, { body: 'трети' });

        const thread = await readPostReplies(ctxFor(MEMBER), parent.postId, {});
        // The ORDER is the assertion. Newest-first — the feed's direction —
        // would read the conversation backwards and the answers would arrive
        // before the questions they answer.
        expect(thread.replies.map((r) => r.id))
            .toEqual([first.postId, second.postId, third.postId]);
    }, 60_000);

    it('pages FORWARD with `after`, and the page boundary loses nothing', async () => {
        const parent = await postToChannel(ctxFor(ASKER), channelId, { body: 'страници' });
        const ids: string[] = [];
        for (let i = 0; i < 5; i += 1) {
            ids.push((await replyToPost(ctxFor(MEMBER), parent.postId, { body: `р${i}` })).postId);
        }

        const page1 = await readPostReplies(ctxFor(MEMBER), parent.postId, { limit: 2 });
        expect(page1.replies.map((r) => r.id)).toEqual(ids.slice(0, 2));
        // `hasMore` comes from a limit+1 probe, so it must be true with three
        // left rather than only when a page comes back full.
        expect(page1.hasMore).toBe(true);

        const page2 = await readPostReplies(ctxFor(MEMBER), parent.postId, {
            limit: 2, after: page1.replies[1]!.createdAt,
        });
        expect(page2.replies.map((r) => r.id)).toEqual(ids.slice(2, 4));

        const page3 = await readPostReplies(ctxFor(MEMBER), parent.postId, {
            limit: 2, after: page2.replies[1]!.createdAt,
        });
        expect(page3.replies.map((r) => r.id)).toEqual(ids.slice(4));
        expect(page3.hasMore).toBe(false);

        // The UNION is the real assertion: three pages that each look right
        // can still drop a row at a boundary.
        expect([...page1.replies, ...page2.replies, ...page3.replies].map((r) => r.id))
            .toEqual(ids);
    }, 90_000);

    it('a NON-MEMBER reads the thread, exactly as they read the feed', async () => {
        // Not a weaker rule and not a stronger one: `channel_post_select`
        // admits any authenticated caller, so the database already allows this
        // and an API that refused would be a second, disagreeing answer.
        const parent = await postToChannel(ctxFor(ASKER), channelId, { body: 'публично' });
        await replyToPost(ctxFor(MEMBER), parent.postId, { body: 'видимо' });

        const thread = await readPostReplies(ctxFor(OUTSIDER), parent.postId, {});
        expect(thread.replies).toHaveLength(1);
        expect(thread.replies[0]!.body).toBe('видимо');
    }, 60_000);

    it('an AUTO-HIDDEN reply comes back EMPTY — the leak this path could have been', async () => {
        // THE LOAD-BEARING CASE. P9.3d's auto-hide sets `autoHiddenAt` on any
        // post including a reply, and the feed collapses three removal columns
        // into `deleted` plus an empty body. A second read path that forgot
        // that collapse would serve the text of a post the moderation path had
        // taken down — which is why both paths go through ONE mapper.
        const parent = await postToChannel(ctxFor(ASKER), channelId, { body: 'скрит отговор' });
        const reply = await replyToPost(ctxFor(MEMBER), parent.postId, { body: 'нарушение' });
        await prisma.channelPost.update({
            where: { id: reply.postId },
            data: { autoHiddenAt: new Date() },
        });

        const thread = await readPostReplies(ctxFor(MEMBER), parent.postId, {});
        expect(thread.replies).toHaveLength(1);
        expect(thread.replies[0]!.deleted).toBe(true);
        expect(thread.replies[0]!.body).toBe('');
        // And the row is NOT omitted: a thread that dropped it would make a
        // reply quoting it dangle, and would tell the reader nothing happened.
        expect(thread.replies[0]!.id).toBe(reply.postId);

        // The text is still STORED, so a moderator review can restore it.
        const row = await prisma.channelPost.findUniqueOrThrow({
            where: { id: reply.postId }, select: { body: true },
        });
        expect(row.body).toBe('нарушение');
    }, 60_000);

    it('serves the thread of a HIDDEN PARENT', async () => {
        // Withholding it would let the moderation of ONE post silently remove
        // other people's words, and the feed already shows a hidden parent
        // rather than omitting it precisely so its replies do not dangle.
        const parent = await postToChannel(ctxFor(ASKER), channelId, { body: 'скрит родител' });
        const reply = await replyToPost(ctxFor(MEMBER), parent.postId, { body: 'оцелява' });
        await prisma.channelPost.update({
            where: { id: parent.postId },
            data: { removedByModerationAt: new Date() },
        });

        const thread = await readPostReplies(ctxFor(MEMBER), parent.postId, {});
        expect(thread.replies.map((r) => r.id)).toEqual([reply.postId]);
        expect(thread.replies[0]!.body).toBe('оцелява');
    }, 60_000);

    it('refuses a reply\'s own thread, rather than answering an empty page', async () => {
        const parent = await postToChannel(ctxFor(ASKER), channelId, { body: 'дълбочина' });
        const reply = await replyToPost(ctxFor(MEMBER), parent.postId, { body: 'отговор' });

        // An empty page would say "no replies", which is a different fact from
        // "that id is not a thread" — and only the second is fixable by the
        // caller. Threads are one level deep, so a reply HAS no thread.
        // `toMatchObject({ code })`, the repo convention: the thrown error's
        // MESSAGE is the prose a client displays, and the code is a property.
        // `toThrow(/CODE/)` greps the sentence and passes only by accident.
        await expect(readPostReplies(ctxFor(MEMBER), reply.postId, {}))
            .rejects.toMatchObject({ code: 'CHANNEL_POST_IS_A_REPLY' });
    }, 60_000);

    it('refuses an unknown post with NOT_FOUND, not an empty page', async () => {
        await expect(readPostReplies(ctxFor(MEMBER), `missing-${randomUUID()}`, {}))
            .rejects.toMatchObject({ code: 'CHANNEL_POST_NOT_FOUND' });
    }, 60_000);

    it('the feed reports replyCount, so a thread is visible without a fetch per post', async () => {
        const parent = await postToChannel(ctxFor(ASKER), channelId, { body: 'брой' });
        const bare = await postToChannel(ctxFor(ASKER), channelId, { body: 'без отговори' });
        await replyToPost(ctxFor(MEMBER), parent.postId, { body: 'а' });
        await replyToPost(ctxFor(MEMBER), parent.postId, { body: 'б' });

        const feed = await readChannelFeed(ctxFor(MEMBER), channelId, { limit: 100 });
        const withReplies = feed.posts.find((p) => p.id === parent.postId);
        const without = feed.posts.find((p) => p.id === bare.postId);
        expect(withReplies!.replyCount).toBe(2);
        // The control: a count that was always non-zero would pass the line
        // above while saying nothing.
        expect(without!.replyCount).toBe(0);
    }, 60_000);

    it('replyCount counts a HIDDEN reply too', async () => {
        // A count that shrank when a moderator hid one reply would tell every
        // reader that something had been removed — the disclosure the
        // `deleted` collapse exists to prevent, arriving by arithmetic.
        const parent = await postToChannel(ctxFor(ASKER), channelId, { body: 'скрит в броя' });
        const a = await replyToPost(ctxFor(MEMBER), parent.postId, { body: 'едно' });
        await replyToPost(ctxFor(MEMBER), parent.postId, { body: 'две' });
        await prisma.channelPost.update({
            where: { id: a.postId }, data: { autoHiddenAt: new Date() },
        });

        const feed = await readChannelFeed(ctxFor(MEMBER), channelId, { limit: 100 });
        expect(feed.posts.find((p) => p.id === parent.postId)!.replyCount).toBe(2);
    }, 60_000);

    it('«Решено» is OBSERVABLE — the second half of the defect', async () => {
        const q = await postToChannel(ctxFor(ASKER), channelId, {
            body: 'Какъв е добивът?', kind: 'QUESTION',
        });

        const before = await readChannelFeed(ctxFor(MEMBER), channelId, { limit: 100 });
        expect(before.posts.find((p) => p.id === q.postId)!.resolvedAt).toBeNull();

        await setQuestionResolved(ctxFor(ASKER), q.postId, true);

        const after = await readChannelFeed(ctxFor(MEMBER), channelId, { limit: 100 });
        // A timestamp, not a boolean: «Решено» is one nullable column, and the
        // WHEN is what an «Активност» surface would sort or date from.
        expect(after.posts.find((p) => p.id === q.postId)!.resolvedAt).not.toBeNull();
    }, 60_000);

    it('un-resolving is visible too, so the state is not one-way', async () => {
        const q = await postToChannel(ctxFor(ASKER), channelId, {
            body: 'Втори въпрос?', kind: 'QUESTION',
        });
        await setQuestionResolved(ctxFor(ASKER), q.postId, true);
        await setQuestionResolved(ctxFor(ASKER), q.postId, false);

        const feed = await readChannelFeed(ctxFor(MEMBER), channelId, { limit: 100 });
        expect(feed.posts.find((p) => p.id === q.postId)!.resolvedAt).toBeNull();
    }, 60_000);

    it('a plain POST carries a null resolvedAt rather than being absent', async () => {
        // The field is on every post, so a client need not branch on `kind`
        // before reading it.
        const p = await postToChannel(ctxFor(ASKER), channelId, { body: 'обикновена' });
        const feed = await readChannelFeed(ctxFor(MEMBER), channelId, { limit: 100 });
        const view = feed.posts.find((x) => x.id === p.postId)!;
        expect(view).toHaveProperty('resolvedAt');
        expect(view.resolvedAt).toBeNull();
    }, 60_000);
});
