/**
 * #2990 — the read cursor and the unread count, against a real database.
 *
 * `ChannelMembership.lastReadAt` was declared by P9.1 and written by NOTHING.
 * Its only consumer was the Art 15 export, which is worse than dead: a column
 * read by a real consumer does not LOOK dead to a keyword sweep. And the
 * policy that permits this write, `channel_membership_update`, carried a
 * docblock whose only stated justification was the write nobody had built.
 *
 * ## Why the count is asserted here rather than in a unit test
 *
 * It is one raw SQL join, so a mocked Prisma would be asserting my own string.
 * The four rules it encodes are each a clause in that statement, and a clause
 * is exactly the thing a double cannot get wrong on your behalf.
 *
 * The rules, and what each one is protecting against:
 *
 *   - TOP-LEVEL only — a badge that counts replies promises activity the feed
 *     does not show;
 *   - not the caller's OWN posts — posting must not badge the channel;
 *   - a never-read channel counts from `joinedAt` — otherwise a new member of
 *     a busy channel gets a badge of its whole history;
 *   - a hidden post is GONE, not unread — counting one gives a badge that
 *     reading can never clear.
 *
 * ## The cursor moves FORWARD only
 *
 * `markReadFor` in `exchange-messaging.ts` is the precedent and the reason is
 * the same: a stale client must not resurrect read posts as unread. The
 * `lt: at` guard is asserted by sending an OLDER timestamp and requiring the
 * stored value not to move — and requiring the call to report the STORED
 * cursor rather than echoing what it was sent, which is the half that tells a
 * client it was stale.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    joinChannel, listChannels, markChannelRead, postToChannel,
} from '@/app-layer/usecases/channels';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const READER = `u-unread-reader-${randomUUID()}`;
const AUTHOR = `u-unread-author-${randomUUID()}`;
const OUTSIDER = `u-unread-outsider-${randomUUID()}`;

const KEY = `crop:unread-${randomUUID()}`;
let channelId = '';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

async function unreadFor(userId: string): Promise<number | null | undefined> {
    const rows = await listChannels(ctxFor(userId));
    return rows.find((r) => r.id === channelId)?.unreadCount;
}

/** A post written directly, so its columns can be set without a usecase. */
async function seedPost(opts: {
    author: string;
    createdAt: Date;
    parentPostId?: string | null;
    deletedAt?: Date | null;
    removedByModerationAt?: Date | null;
    autoHiddenAt?: Date | null;
}): Promise<string> {
    const row = await prisma.channelPost.create({
        data: {
            channelId,
            authorUserId: opts.author,
            body: 'тест',
            createdAt: opts.createdAt,
            parentPostId: opts.parentPostId ?? null,
            deletedAt: opts.deletedAt ?? null,
            removedByModerationAt: opts.removedByModerationAt ?? null,
            autoHiddenAt: opts.autoHiddenAt ?? null,
        },
        select: { id: true },
    });
    return row.id;
}

describeFn('#2990 — the read cursor and the unread count', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: KEY, nameBg: 'Непрочетени', nameEn: 'Unread', kind: 'CROP' },
            select: { id: true },
        });
        channelId = c.id;
        await joinChannel(ctxFor(READER), channelId);
        await joinChannel(ctxFor(AUTHOR), channelId);
    });

    afterAll(async () => {
        // BY ID — tenantless, so a blanket delete would take the 43 real
        // catalogue channels with it.
        await prisma.channel.deleteMany({ where: { id: channelId } });
        await prisma.$disconnect();
    });

    describe('the count', () => {
        it('is NULL for a channel the caller has not joined, never 0', async () => {
            // The two states a badge most needs to tell apart: "not mine" and
            // "mine and caught up".
            expect(await unreadFor(OUTSIDER)).toBeNull();
            expect(await unreadFor(READER)).not.toBeNull();
        }, 60_000);

        it('counts a top-level post by somebody else', async () => {
            const before = (await unreadFor(READER)) ?? 0;
            await seedPost({ author: AUTHOR, createdAt: new Date() });
            expect(await unreadFor(READER)).toBe(before + 1);
        }, 60_000);

        it('does NOT count the caller’s OWN post', async () => {
            const before = (await unreadFor(READER)) ?? 0;
            await seedPost({ author: READER, createdAt: new Date() });
            expect(await unreadFor(READER)).toBe(before);
        }, 60_000);

        it('does NOT count a REPLY — the badge is feed activity', async () => {
            const parent = await seedPost({ author: AUTHOR, createdAt: new Date() });
            const after = (await unreadFor(READER)) ?? 0;
            await seedPost({ author: AUTHOR, createdAt: new Date(), parentPostId: parent });
            // The parent counted; the reply did not.
            expect(await unreadFor(READER)).toBe(after);
        }, 60_000);

        it.each([
            ['deletedAt', { deletedAt: new Date() }],
            ['removedByModerationAt', { removedByModerationAt: new Date() }],
            ['autoHiddenAt', { autoHiddenAt: new Date() }],
        ])('does NOT count a post hidden by %s', async (_label, columns) => {
            // All THREE, separately. Collapsing them into one case would leave
            // two clauses of the SQL unexercised, and a count that includes a
            // hidden post is a badge reading can never clear.
            const before = (await unreadFor(READER)) ?? 0;
            await seedPost({ author: AUTHOR, createdAt: new Date(), ...columns });
            expect(await unreadFor(READER)).toBe(before);
        }, 60_000);

        it('counts from joinedAt for a NEVER-READ channel, not from the beginning', async () => {
            // The post predates the membership, so a `-infinity` fallback
            // would count it. A new member of a 2,000-post channel must not
            // open the app to a badge of 2,000.
            const latecomer = `u-unread-late-${randomUUID()}`;
            await seedPost({
                author: AUTHOR,
                createdAt: new Date(Date.now() - 86_400_000),
            });
            await joinChannel(ctxFor(latecomer), channelId);

            expect(await unreadFor(latecomer)).toBe(0);

            // And a post AFTER joining does count — the control, without which
            // "0" is satisfied by a count that never counts anything.
            await seedPost({ author: AUTHOR, createdAt: new Date() });
            expect(await unreadFor(latecomer)).toBe(1);
        }, 60_000);

        it('drops to zero once the cursor is moved', async () => {
            await seedPost({ author: AUTHOR, createdAt: new Date() });
            expect((await unreadFor(READER)) ?? 0).toBeGreaterThan(0);

            await markChannelRead(ctxFor(READER), channelId);
            expect(await unreadFor(READER)).toBe(0);
        }, 60_000);
    });

    describe('the cursor', () => {
        it('moves FORWARD only — an older timestamp is refused silently', async () => {
            const forward = new Date();
            await markChannelRead(ctxFor(READER), channelId, forward);

            const backwards = new Date(forward.getTime() - 60_000);
            const result = await markChannelRead(ctxFor(READER), channelId, backwards);

            // Reports the STORED value, not the one it was sent — which is how
            // a stale client learns the real cursor instead of being told its
            // own number back.
            expect(result.lastReadAt).toBe(forward.toISOString());

            const row = await prisma.channelMembership.findFirst({
                where: { channelId, userId: READER },
                select: { lastReadAt: true },
            });
            expect(row!.lastReadAt!.toISOString()).toBe(forward.toISOString());
        }, 60_000);

        it('REFUSES a non-member with a code, rather than inserting a membership', async () => {
            // On the `code` PROPERTY, not in the message. `codedNotFound`
            // carries the code separately — asserting the prose would pass
            // today and break the moment the sentence is reworded, which is
            // the drift `coding-a-throw-changes-the-copy` names, and it would
            // also not be asserting the thing a client reads.
            const err = await markChannelRead(ctxFor(OUTSIDER), channelId).then(
                () => null,
                (e: unknown) => e as { code?: string },
            );
            expect(err?.code).toBe('CHANNEL_NOT_JOINED');
            // The half that matters: no membership was created. An insert here
            // would be a second `ChannelMembership` writer, which
            // `channels-are-never-auto-joined` refuses by name.
            const row = await prisma.channelMembership.findFirst({
                where: { channelId, userId: OUTSIDER },
                select: { id: true },
            });
            expect(row).toBeNull();
        }, 60_000);
    });
});
