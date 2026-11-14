/**
 * P9.7 (#2941) — «За Вас»: what happened to the caller across every channel.
 *
 * ## The channel key avoids `crop:` / `input:` / `oblast:` ON PURPOSE
 *
 * `p9-2-seed-channels` clears channels by PREFIX, so any key under those three
 * is liable to be deleted by another suite between runs. Nothing here depends
 * on the key — activity is read from posts, not from the catalogue — so the
 * fixture uses a prefix no other suite claims. That is the lesson #3066 paid
 * for: a fixture that shares a namespace with another suite inherits its
 * lifecycle.
 *
 * ## Every negative is paired
 *
 * "Nothing appeared" passes against a read that returns nothing for everyone,
 * so each exclusion is asserted beside an inclusion in the same page.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    joinChannel, postToChannel, replyToPost, readMyActivity,
} from '@/app-layer/usecases/channels';
import type { UserContext } from '@/app-layer/types';
import { hashForLookup } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** The reader — the person «За Вас» is about. */
const ME = `u-2941-me-${randomUUID()}`;
/** Mentions and replies to ME. */
const OTHER = `u-2941-other-${randomUUID()}`;
/** Has BLOCKED me, and may still appear here — see the #3065 case. */
const BLOCKER = `u-2941-blocker-${randomUUID()}`;
/** Neither party; their activity must never reach ME. */
const STRANGER = `u-2941-stranger-${randomUUID()}`;

const FARM = `t-2941-${randomUUID()}`;
const FARM_SLUG = `p2941-${randomUUID()}`.slice(0, 40);
const KEY = `topic:p9-7-${randomUUID()}`;
let channelId = '';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

const USERS = [ME, OTHER, BLOCKER, STRANGER];

describeFn('#2941 — «За Вас» shows what happened to the caller', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: KEY, nameBg: 'Тест', nameEn: 'Test', kind: 'TOPIC' },
            select: { id: true },
        });
        channelId = c.id;
        await prisma.tenant.create({ data: { id: FARM, slug: FARM_SLUG, name: 'ЗК Тест' } });
        for (const u of USERS) {
            const email = `${u}@example.test`;
            await prisma.user.create({
                data: { id: u, email, emailHash: hashForLookup(email) },
            });
            await prisma.tenantMembership.create({
                data: { tenantId: FARM, userId: u, role: 'EDITOR', status: 'ACTIVE' },
            });
            await joinChannel(ctxFor(u), channelId);
        }
        // BLOCKER refuses ME. #3065 stops them INTERRUPTING me; this file
        // asserts it does not make their posts vanish from a pull surface.
        await prisma.userBlock.create({
            data: { blockerUserId: BLOCKER, blockedUserId: ME },
        });
    });

    afterAll(async () => {
        await prisma.userBlock.deleteMany({
            where: { OR: [{ blockerUserId: { in: USERS } }, { blockedUserId: { in: USERS } }] },
        });
        await prisma.channel.deleteMany({ where: { id: channelId } });
        await prisma.tenantMembership.deleteMany({ where: { userId: { in: USERS } } });
        await prisma.user.deleteMany({ where: { id: { in: USERS } } });
        await prisma.tenant.deleteMany({ where: { id: FARM } });
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        await prisma.channelPost.deleteMany({ where: { channelId } });
    });

    const mine = async () => readMyActivity(ctxFor(ME), {});

    it('shows a MENTION of me, naming the channel and why', async () => {
        const { postId } = await postToChannel(ctxFor(OTHER), channelId, {
            body: 'Питам Иван',
            mentionUserIds: [ME],
        });

        const { items, hasMore } = await mine();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            reason: 'mention',
            channelId,
            channelNameBg: 'Тест',
            // Top-level, so there is no thread to open instead.
            parentPostId: null,
        });
        expect(items[0]!.post.id).toBe(postId);
        expect(items[0]!.post.body).toBe('Питам Иван');
        expect(hasMore).toBe(false);
    }, 60_000);

    it('shows a REPLY to my post, and carries the parent so a client opens the thread', async () => {
        const parent = await postToChannel(ctxFor(ME), channelId, { body: 'Моята публикация' });
        const reply = await replyToPost(ctxFor(OTHER), parent.postId, { body: 'Отговор' });

        const { items } = await mine();
        // ONE item: my own parent post is not activity, the reply is.
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ reason: 'reply', parentPostId: parent.postId });
        expect(items[0]!.post.id).toBe(reply.postId);
    }, 60_000);

    it('never shows my OWN act — a reply to my own post', async () => {
        /*
         * A SELF-REPLY, and the first draft of this test used a self-MENTION,
         * which could not fail. `resolveRecordableMentions` filters
         * `id !== authorUserId` before any row is written, so a post where I
         * mention myself has no `ChannelPostMention` row at all — the `OR`
         * never matches it, and the `authorUserId` clause is idle. Removing
         * that clause left all eight cases green, which the mutation proof is
         * what revealed.
         *
         * A reply to my own post DOES match the `OR`, through
         * `parentPost.authorUserId`, so the author filter is the only thing
         * excluding it. That makes this the case the clause exists for.
         */
        const parent = await postToChannel(ctxFor(ME), channelId, { body: 'Моята' });
        await replyToPost(ctxFor(ME), parent.postId, { body: 'Отговарям си сам' });

        // THE CONTROL, in the same page: somebody else's reply to the SAME
        // post does appear, so this asserts the author filter rather than an
        // empty read.
        const theirs = await replyToPost(ctxFor(OTHER), parent.postId, { body: 'Техен' });

        const { items } = await mine();
        expect(items).toHaveLength(1);
        expect(items[0]!.post.id).toBe(theirs.postId);
    }, 60_000);

    it('records no self-mention, so mentioning myself produces nothing to show', async () => {
        // The behaviour the case above used to rely on, asserted directly
        // rather than as a side effect — so if `resolveRecordableMentions`
        // ever started recording self-mentions, that change fails HERE
        // instead of silently making the test above vacuous again.
        await postToChannel(ctxFor(ME), channelId, {
            body: 'Говоря на себе си',
            mentionUserIds: [ME],
        });
        expect((await mine()).items).toHaveLength(0);
    }, 60_000);

    it('reports MENTION when a reply also mentions me — the more specific fact', async () => {
        const parent = await postToChannel(ctxFor(ME), channelId, { body: 'Въпрос' });
        await replyToPost(ctxFor(OTHER), parent.postId, {
            body: 'Отговор със споменаване',
            mentionUserIds: [ME],
        });

        const { items } = await mine();
        expect(items).toHaveLength(1);
        // The same precedence `reachableTargets` applies, so the notification
        // and this surface cannot disagree about what the event was.
        expect(items[0]!.reason).toBe('mention');
        // And the parent still rides along, so the thread is still openable.
        expect(items[0]!.parentPostId).toBe(parent.postId);
    }, 60_000);

    it('keeps a HIDDEN post as a row, collapsed rather than omitted', async () => {
        const { postId } = await postToChannel(ctxFor(OTHER), channelId, {
            body: 'Ще бъде премахнато',
            mentionUserIds: [ME],
        });
        await prisma.channelPost.update({
            where: { id: postId },
            data: { removedByModerationAt: new Date() },
        });

        const { items } = await mine();
        // STILL A ROW: a person notified about something must find something,
        // and the collapse is what withholds the content.
        expect(items).toHaveLength(1);
        expect(items[0]!.post.deleted).toBe(true);
        expect(items[0]!.post.body).toBe('');
        // Nobody is named above content nobody can read (#2989).
        expect(items[0]!.post.author).toBeNull();
    }, 60_000);

    it('STILL shows a mention from somebody who blocked me (#3065 boundary)', async () => {
        await postToChannel(ctxFor(BLOCKER), channelId, {
            body: 'Споменаване от блокиращ',
            mentionUserIds: [ME],
        });

        const { items } = await mine();
        // #3065 stopped the INTERRUPTION — no push, no SSE frame. It did not
        // make the post invisible, and this is a PULL surface: the reader
        // opens it. Filtering here would also be a half-measure, because the
        // post is readable in the channel feed either way.
        expect(items).toHaveLength(1);
        expect(items[0]!.reason).toBe('mention');
    }, 60_000);

    it('never shows activity between two OTHER people', async () => {
        const theirs = await postToChannel(ctxFor(STRANGER), channelId, { body: 'Тяхна' });
        await replyToPost(ctxFor(OTHER), theirs.postId, { body: 'Техен отговор' });
        await postToChannel(ctxFor(STRANGER), channelId, {
            body: 'Споменава друг',
            mentionUserIds: [OTHER],
        });

        const { items } = await mine();
        expect(items).toHaveLength(0);

        // THE PAIRING: the same channel, the same readers, one mention of ME —
        // so the empty result above is the filter and not a broken read.
        await postToChannel(ctxFor(STRANGER), channelId, {
            body: 'Споменава мен',
            mentionUserIds: [ME],
        });
        expect((await mine()).items).toHaveLength(1);
    }, 60_000);

    it('pages on `before`, newest first, with an honest hasMore', async () => {
        for (let i = 0; i < 3; i += 1) {
            await postToChannel(ctxFor(OTHER), channelId, {
                body: `Споменаване ${i}`,
                mentionUserIds: [ME],
            });
        }

        const first = await readMyActivity(ctxFor(ME), { limit: 2 });
        expect(first.items).toHaveLength(2);
        // `limit + 1` is the probe, so hasMore is the query's answer and not a
        // count of what was filtered afterwards.
        expect(first.hasMore).toBe(true);

        const second = await readMyActivity(ctxFor(ME), {
            limit: 2,
            before: first.items.at(-1)!.post.createdAt,
        });
        expect(second.items).toHaveLength(1);
        expect(second.hasMore).toBe(false);

        // NO OVERLAP across the boundary, which is what the cursor is for.
        const ids = new Set([...first.items, ...second.items].map((i) => i.post.id));
        expect(ids.size).toBe(3);
    }, 60_000);
});
