/**
 * #3042 — the mute gets its writer, against a real database.
 *
 * `ChannelMembership.mutedAt` was HONOURED and unwritable. `reachableTargets`
 * has filtered on it since #2987 for every mention and reply, so a muted
 * member is not pushed to — and nothing could set it. A mute control on the
 * phone would have done nothing while looking exactly like a working one,
 * which is the sentence #2987 was filed about arriving back at the same column
 * from the other side.
 *
 * ## The case that matters is the SUPPRESSION, not the column
 *
 * Asserting that `mutedAt` is written is asserting an UPDATE works. The
 * property worth protecting is that a muted person stops being a target — so
 * the last describe drives `reachableTargets` through a real post and requires
 * the muted member to be absent from it, with an UNMUTED member present in the
 * same call as the control. Without that control, "absent" is satisfied by a
 * resolver that returns nobody.
 *
 * ## Deliberately NOT asserted: a monotonic guard
 *
 * The read cursor next door refuses to move backwards. A mute is a toggle with
 * no order, so there is nothing to protect — and a guard copied for its shape
 * would make unmuting impossible, since clearing a column is not "moving
 * forward". That is why there is no stale-client case here and three of them
 * in `p9-unread-counts`.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

/**
 * `enqueue` is the ONE mock here, for `channel-mention-notifies`' reason: the
 * suppression is observable as a job that is NOT enqueued, and a real queue
 * would need Redis. What is asserted is the DECISION — who was enqueued for —
 * not that a queue accepted it.
 */
const enqueueMock = jest.fn().mockResolvedValue(undefined);
jest.mock('@/app-layer/jobs/queue', () => ({
    __esModule: true,
    enqueue: (...a: unknown[]) => enqueueMock(...a),
}));

import {
    joinChannel, listChannels, setChannelMuted, postToChannel,
} from '@/app-layer/usecases/channels';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const MUTER = `u-mute-muter-${randomUUID()}`;
const HEARER = `u-mute-hearer-${randomUUID()}`;
const AUTHOR = `u-mute-author-${randomUUID()}`;
const OUTSIDER = `u-mute-outsider-${randomUUID()}`;

const KEY = `crop:mute-${randomUUID()}`;
let channelId = '';

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

async function mutedFor(userId: string): Promise<boolean | null | undefined> {
    const rows = await listChannels(ctxFor(userId));
    return rows.find((r) => r.id === channelId)?.muted;
}

async function storedMutedAt(userId: string): Promise<Date | null> {
    const row = await prisma.channelMembership.findFirst({
        where: { channelId, userId },
        select: { mutedAt: true },
    });
    return row?.mutedAt ?? null;
}

describeFn('#3042 — the mute writer', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const c = await prisma.channel.create({
            data: { key: KEY, nameBg: 'Заглушен', nameEn: 'Muted', kind: 'CROP' },
            select: { id: true },
        });
        channelId = c.id;
        await joinChannel(ctxFor(MUTER), channelId);
        await joinChannel(ctxFor(HEARER), channelId);
        await joinChannel(ctxFor(AUTHOR), channelId);
    });

    afterAll(async () => {
        // BY ID — tenantless, so a blanket delete would take the real
        // catalogue channels with it.
        await prisma.channel.deleteMany({ where: { id: channelId } });
        await prisma.$disconnect();
    });

    describe('the write', () => {
        it('mutes, and the directory reports it', async () => {
            expect(await mutedFor(MUTER)).toBe(false);

            const r = await setChannelMuted(ctxFor(MUTER), channelId, true);

            expect(r.muted).toBe(true);
            expect(r.mutedAt).not.toBeNull();
            expect(await mutedFor(MUTER)).toBe(true);
            expect(await storedMutedAt(MUTER)).not.toBeNull();
        }, 60_000);

        it('is IDEMPOTENT and does not re-stamp the moment of the choice', async () => {
            const first = await storedMutedAt(MUTER);
            expect(first).not.toBeNull();

            const again = await setChannelMuted(ctxFor(MUTER), channelId, true);

            // The STORED value comes back, not the request's. `mutedAt` is when
            // the person chose silence; an idempotent call must not rewrite
            // history to report success — and a function that echoed its input
            // could not tell a caller it had done nothing (#2990).
            expect(again.muted).toBe(true);
            expect(again.mutedAt).toBe(first!.toISOString());
            expect((await storedMutedAt(MUTER))!.toISOString()).toBe(first!.toISOString());
        }, 60_000);

        it('unmutes by writing NULL, and KEEPS the membership row', async () => {
            // Deleting the row to unmute would discard `lastReadAt` and
            // `joinedAt` — P9.5's "leaving is not lossless", reached by
            // accident rather than by a Leave button.
            const before = await prisma.channelMembership.findFirst({
                where: { channelId, userId: MUTER },
                select: { id: true, joinedAt: true },
            });

            const r = await setChannelMuted(ctxFor(MUTER), channelId, false);

            expect(r.muted).toBe(false);
            expect(r.mutedAt).toBeNull();
            expect(await storedMutedAt(MUTER)).toBeNull();

            const after = await prisma.channelMembership.findFirst({
                where: { channelId, userId: MUTER },
                select: { id: true, joinedAt: true },
            });
            expect(after).not.toBeNull();
            expect(after!.id).toBe(before!.id);
            expect(after!.joinedAt.toISOString()).toBe(before!.joinedAt.toISOString());
        }, 60_000);

        it('unmuting an unmuted channel is not an error', async () => {
            const r = await setChannelMuted(ctxFor(MUTER), channelId, false);
            expect(r).toEqual({ muted: false, mutedAt: null });
        }, 60_000);

        it('REFUSES a non-member rather than inserting a membership', async () => {
            const err = await setChannelMuted(ctxFor(OUTSIDER), channelId, true).then(
                () => null,
                (e: unknown) => e as { code?: string },
            );
            expect(err?.code).toBe('CHANNEL_NOT_JOINED');

            // The half that matters: an insert here would be a second
            // `ChannelMembership` writer, which
            // `channels-are-never-auto-joined` refuses by name.
            const row = await prisma.channelMembership.findFirst({
                where: { channelId, userId: OUTSIDER },
                select: { id: true },
            });
            expect(row).toBeNull();
        }, 60_000);

        it('reports NULL rather than false for a channel the caller has not joined', async () => {
            expect(await mutedFor(OUTSIDER)).toBeNull();
        }, 60_000);
    });

    describe('the suppression — what the column is FOR', () => {
        /** Every `person-push-send` payload enqueued for one person. */
        const pushesFor = (userId: string) =>
            enqueueMock.mock.calls
                .filter((c) => c[0] === 'person-push-send')
                .map((c) => c[1] as Record<string, unknown>)
                .filter((p) => p.recipientUserId === userId);

        it('a muted member gets NO push and an unmuted one does', async () => {
            // THE PROPERTY, not the column. The first draft of this case was
            // vacuous: it asserted a dummy `SELECT 1` and the presence of the
            // mention rows, under a name claiming the suppression — a test
            // name asserting a cause its body never removed. Asserting
            // `mutedAt` is written only asserts that an UPDATE works.
            enqueueMock.mockClear();
            await setChannelMuted(ctxFor(MUTER), channelId, true);
            await setChannelMuted(ctxFor(HEARER), channelId, false);
            enqueueMock.mockClear();

            await postToChannel(ctxFor(AUTHOR), channelId, {
                body: 'Споменавам и двамата',
                mentionUserIds: [MUTER, HEARER],
            });

            // The UNMUTED member is the control. Without it, "no push for the
            // muted member" is satisfied by a post that notified nobody at
            // all — which is what a broken mention resolution looks like.
            expect(pushesFor(HEARER)).toHaveLength(1);
            expect(pushesFor(MUTER)).toHaveLength(0);
        }, 60_000);

        it('the mention ROW is still written for a muted member', async () => {
            // `resolveMentionable` deliberately does not filter `mutedAt`: a
            // mention is a record of being NAMED, a mute is a statement about
            // being INTERRUPTED. So muting must suppress the push without
            // erasing the record — and the Art 15 export reads those rows.
            const mentions = await prisma.channelPostMention.findMany({
                where: { userId: { in: [MUTER, HEARER] } },
                select: { userId: true },
            });
            const named = new Set(mentions.map((m) => m.userId));
            expect(named.has(MUTER)).toBe(true);
            expect(named.has(HEARER)).toBe(true);
        }, 60_000);
    });
});
