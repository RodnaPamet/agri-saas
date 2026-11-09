/**
 * P9.3a — the channel core, executed against a real database (#2937).
 *
 * The directory, joining and leaving, the feed, and posting with slow mode.
 *
 * ## It runs the USECASES, not raw SQL
 *
 * `p9-1-channels-rls.test.ts` proves the POLICIES by driving raw statements
 * under `runInUserContext`. This file proves the FEATURE: that the usecases
 * reach those policies, maintain the denormalised counter, and refuse with a
 * code a client can act on rather than with a Prisma error.
 *
 * Both are needed and neither subsumes the other. #1664 is the case where the
 * table's policies were correct, their own test passed, and the feature was
 * silently dead because the production caller ran in the other session
 * context — "asserting the table's policies from the right context proves the
 * policy, not the feature".
 *
 * ## TWO LAYERS on posting, and this file asserts the readable one
 *
 * `channel_post_insert`'s WITH CHECK is the guarantee. The usecase's
 * membership read is for the MESSAGE — a policy refusal arrives as a Prisma
 * error and would surface as a 500. So the cases below assert the CODES.
 *
 * **The guarantee is proved by `p9-1-channels-rls.test.ts`, not from here.**
 * That suite drives a raw INSERT as a non-member under `runInUserContext` and
 * asserts the `row-level security` refusal, which establishes the policy
 * independently of anything this file does.
 *
 * Worth recording why it is not proved by mutating this file: I tried three
 * times and every attempt measured something else. Disabling the `!membership`
 * throw leaves the next line dereferencing a null `membership.bannedAt`, so the
 * refusal was a TypeError. Removing the whole block broke the module, so the
 * refusal was a failed import. Both times the probe's own assertion — "no row
 * was written" — passed, for a reason that had nothing to do with RLS.
 *
 * That is the shape to watch for: a probe whose green answer is produced by
 * several different broken mechanisms is not evidence about the one you meant.
 * The direct-insert test is evidence because nothing stands between it and the
 * policy.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    listChannels, joinChannel, leaveChannel, postToChannel, readChannelFeed,
} from '@/app-layer/usecases/channels';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const MEMBER = `u-p93a-member-${randomUUID()}`;
const OUTSIDER = `u-p93a-outsider-${randomUUID()}`;
const BANNED = `u-p93a-banned-${randomUUID()}`;

const KEY = `crop:p93a-${randomUUID()}`;
const SLOW_KEY = `crop:p93a-slow-${randomUUID()}`;
let channelId = '';
let slowChannelId = '';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

describeFn('P9.3a — the channel core (#2937)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: KEY, nameBg: 'Тест', nameEn: 'Test', kind: 'CROP' },
            select: { id: true },
        });
        channelId = c.id;
        const slow = await prisma.channel.create({
            // 3600s so the window cannot elapse mid-test and make a refusal
            // look like a pass — a short window would be a flake waiting for a
            // slow runner.
            data: {
                key: SLOW_KEY, nameBg: 'Бавен', nameEn: 'Slow',
                kind: 'CROP', slowModeSeconds: 3600,
            },
            select: { id: true },
        });
        slowChannelId = slow.id;
        // The banned member keeps a membership row — that is what enforces the
        // ban, since deleting it would let them rejoin.
        await prisma.channelMembership.create({
            data: { channelId, userId: BANNED, bannedAt: new Date() },
        });
    });

    afterAll(async () => {
        // BY ID. Tenantless, so there is no tenant to cascade from, and a
        // blanket delete would take rows another suite seeded — including the
        // 43 real catalogue channels.
        await prisma.channel.deleteMany({ where: { id: { in: [channelId, slowChannelId] } } });
        await prisma.$disconnect();
    });

    describe('the directory is readable by a NON-member', () => {
        it('an outsider sees the channel, with joined=false', async () => {
            // The departure from a conversation, and the feature rather than a
            // leak: P9.2 cannot suggest a channel nobody can read.
            const rows = await listChannels(ctxFor(OUTSIDER));
            const mine = rows.find((r) => r.id === channelId);
            expect(mine).toBeDefined();
            expect(mine!.joined).toBe(false);
            expect(mine!.banned).toBe(false);
        }, 60_000);

        it('a BANNED member sees banned=true — a ban is not a silent refusal', async () => {
            const rows = await listChannels(ctxFor(BANNED));
            const mine = rows.find((r) => r.id === channelId);
            expect(mine!.joined).toBe(true);
            expect(mine!.banned).toBe(true);
        }, 60_000);
    });

    describe('joining maintains the DENORMALISED counter', () => {
        it('join increments memberCount, and joining twice does not double-count', async () => {
            const before = await prisma.channel.findUniqueOrThrow({
                where: { id: channelId }, select: { memberCount: true },
            });

            const first = await joinChannel(ctxFor(MEMBER), channelId);
            expect(first.alreadyMember).toBe(false);

            const second = await joinChannel(ctxFor(MEMBER), channelId);
            expect(second.alreadyMember).toBe(true);

            const after = await prisma.channel.findUniqueOrThrow({
                where: { id: channelId }, select: { memberCount: true },
            });
            // EXACTLY one, not two. The counter is denormalised because the
            // membership policy admits the caller's own row only, so nothing
            // else can notice it drifting.
            expect(after.memberCount).toBe(before.memberCount + 1);
        }, 60_000);

        it('leave decrements it again', async () => {
            const joiner = `u-p93a-leaver-${randomUUID()}`;
            const before = await prisma.channel.findUniqueOrThrow({
                where: { id: channelId }, select: { memberCount: true },
            });
            await joinChannel(ctxFor(joiner), channelId);
            await leaveChannel(ctxFor(joiner), channelId);
            const after = await prisma.channel.findUniqueOrThrow({
                where: { id: channelId }, select: { memberCount: true },
            });
            expect(after.memberCount).toBe(before.memberCount);
        }, 60_000);

        it('leaving something you are not in is a no-op, not an error', async () => {
            await expect(leaveChannel(ctxFor(OUTSIDER), channelId)).resolves.toBeUndefined();
        }, 60_000);
    });

    describe('posting: the readable refusals', () => {
        it('a MEMBER can post — the positive that makes the refusals mean something', async () => {
            const res = await postToChannel(ctxFor(MEMBER), channelId, { body: 'сеитбата започна' });
            expect(res.postId).toBeTruthy();

            const row = await prisma.channelPost.findUniqueOrThrow({
                where: { id: res.postId },
                select: { body: true, authorUserId: true },
            });
            expect(row.body).toBe('сеитбата започна');
            expect(row.authorUserId).toBe(MEMBER);
        }, 60_000);

        it('a NON-MEMBER gets CHANNEL_NOT_A_MEMBER, not a Prisma error', async () => {
            // The whole point of the usecase layer. The policy would refuse it
            // anyway; this is about the farmer getting something actionable
            // instead of a 500.
            await expect(
                postToChannel(ctxFor(OUTSIDER), channelId, { body: 'здравейте' }),
            ).rejects.toMatchObject({ code: 'CHANNEL_NOT_A_MEMBER' });
        }, 60_000);

        it('a BANNED member gets CHANNEL_BANNED', async () => {
            await expect(
                postToChannel(ctxFor(BANNED), channelId, { body: 'отново' }),
            ).rejects.toMatchObject({ code: 'CHANNEL_BANNED' });
        }, 60_000);

        it('an EMPTY body is refused after sanitising, not before', async () => {
            // `sanitizePlainText` strips markup, so a body of only tags
            // sanitises to nothing — which a `min(1)` on the request schema
            // would have passed. The usecase is where the VALUE is bounded.
            await expect(
                postToChannel(ctxFor(MEMBER), channelId, { body: '<b></b>' }),
            ).rejects.toMatchObject({ code: 'CHANNEL_POST_REQUIRED' });
        }, 60_000);
    });

    describe('slow mode', () => {
        it('refuses a second post inside the window and names the wait', async () => {
            const slowPoster = `u-p93a-slow-${randomUUID()}`;
            await joinChannel(ctxFor(slowPoster), slowChannelId);

            const first = await postToChannel(ctxFor(slowPoster), slowChannelId, { body: 'едно' });
            expect(first.postId).toBeTruthy();

            await expect(
                postToChannel(ctxFor(slowPoster), slowChannelId, { body: 'две' }),
            ).rejects.toMatchObject({ code: 'CHANNEL_SLOW_MODE' });
        }, 60_000);

        it('does not apply to a DIFFERENT member — it is per person, not per channel', async () => {
            // Slow mode throttles an individual. A channel-wide lock would mean
            // one chatty member silencing everybody, which is the opposite of
            // the intent.
            const other = `u-p93a-other-${randomUUID()}`;
            await joinChannel(ctxFor(other), slowChannelId);
            const res = await postToChannel(ctxFor(other), slowChannelId, { body: 'трето' });
            expect(res.postId).toBeTruthy();
        }, 60_000);

        it('is OFF when slowModeSeconds is 0 — the control, so the refusal is not unconditional', async () => {
            const rapid = `u-p93a-rapid-${randomUUID()}`;
            await joinChannel(ctxFor(rapid), channelId);
            const a = await postToChannel(ctxFor(rapid), channelId, { body: 'бързо едно' });
            const b = await postToChannel(ctxFor(rapid), channelId, { body: 'бързо две' });
            expect(a.postId).not.toBe(b.postId);
        }, 60_000);
    });

    describe('the feed', () => {
        it('is readable by a NON-member, like the directory', async () => {
            const feed = await readChannelFeed(ctxFor(OUTSIDER), channelId);
            expect(feed.posts.length).toBeGreaterThan(0);
        }, 60_000);

        it('keeps a removed post as a ROW with an empty body, never omits it', async () => {
            // Omitting it would make a reply above it dangle. The DM precedent:
            // `deleteDirectMessage` writes '' and keeps the row.
            const res = await postToChannel(ctxFor(MEMBER), channelId, { body: 'ще бъде скрито' });
            await prisma.channelPost.update({
                where: { id: res.postId },
                data: { removedByModerationAt: new Date() },
            });

            const feed = await readChannelFeed(ctxFor(MEMBER), channelId, { limit: 100 });
            const hidden = feed.posts.find((p) => p.id === res.postId);
            expect(hidden).toBeDefined();
            expect(hidden!.deleted).toBe(true);
            expect(hidden!.body).toBe('');

            // And the body is still IN the database — hiding is a read-time
            // decision, so #2867's restore has something to restore.
            const row = await prisma.channelPost.findUniqueOrThrow({
                where: { id: res.postId }, select: { body: true },
            });
            expect(row.body).toBe('ще бъде скрито');
        }, 60_000);

        it('reports hasMore from a limit+1 probe, and the page is the limit', async () => {
            const feed = await readChannelFeed(ctxFor(MEMBER), channelId, { limit: 1 });
            expect(feed.posts).toHaveLength(1);
            expect(feed.hasMore).toBe(true);
        }, 60_000);

        it('refuses to read a channel that does not exist', async () => {
            await expect(
                readChannelFeed(ctxFor(MEMBER), `ch-nope-${randomUUID()}`),
            ).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
        }, 60_000);
    });
});
