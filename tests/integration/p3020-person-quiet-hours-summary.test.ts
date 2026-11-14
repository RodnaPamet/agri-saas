/**
 * #3020 — quiet hours HOLD a person-scoped push and one summary arrives at
 * 06:00, instead of the push being dropped.
 *
 * Owner ruling 2026-11-14, two parts: hold-and-summarise rather than drop, and
 * the summary's link is CONDITIONAL — exactly one held item links to that
 * item, several carry no link at all.
 *
 * ## What this file can and cannot prove
 *
 * `enqueue` is the one mock here, as in `channel-mention-notifies`: there is
 * no Redis in this suite, so a real enqueue would fail and the whole half
 * would be untestable. That bounds one claim honestly — **the idempotency of
 * "one summary per person per night" is BullMQ's**, which refuses a duplicate
 * `jobId`, and a mock accepts duplicates cheerfully. So the assertion here is
 * that the `jobId` we hand it is the SAME string for a second mention of the
 * same night; whether BullMQ then dedupes is BullMQ's contract, not ours.
 *
 * Everything else — the rows, the counts, the link rule, the settling — runs
 * against a real database.
 *
 * ## Only `Date` is faked
 *
 * The deferral decision reads `new Date()` inside the job, so the window has
 * to be moved rather than waited for. `doNotFake` keeps every timer real,
 * because Prisma's internals use them and a faked `setTimeout` turns a query
 * into a hang.
 *
 * 2026-11-14 is EET (UTC+2), so 21:00Z is 23:00 Sofia — inside the window —
 * and 10:00Z is 12:00 Sofia, outside it. Both are asserted against
 * `quietNightKey` rather than against a hardcoded string, so a change to the
 * window's definition fails here rather than drifting.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import type { PersonPushSubject } from '@/app-layer/jobs/types';
import { quietNightKey } from '@/lib/notifications/quiet-hours';
import { hashForLookup } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const enqueueMock = jest.fn().mockResolvedValue(undefined);
jest.mock('@/app-layer/jobs/queue', () => ({
    ...(jest.requireActual('@/app-layer/jobs/queue') as object),
    enqueue: (...a: unknown[]) => enqueueMock(...a),
}));

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** Has a device, so a delivery decision can say yes. */
const HELD = `u-3020-held-${randomUUID()}`;
/** No device at all — the settle-though-nothing-was-sent case. */
const NO_DEVICE = `u-3020-nodev-${randomUUID()}`;

const FARM = `t-3020-${randomUUID()}`;
const FARM_SLUG = `p3020-${randomUUID()}`.slice(0, 40);

const INSIDE = new Date('2026-11-14T21:00:00Z');   // 23:00 Sofia
const OUTSIDE = new Date('2026-11-14T10:00:00Z');  // 12:00 Sofia

function fakeNow(at: Date): void {
    jest.useFakeTimers({
        doNotFake: [
            'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
            'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
            'performance', 'hrtime', 'requestAnimationFrame',
            'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
        ],
        now: at,
    });
}

/** Every payload enqueued under one job name. */
function enqueuedOf(name: string): Record<string, unknown>[] {
    return enqueueMock.mock.calls
        .filter((c) => c[0] === name)
        .map((c) => c[1] as Record<string, unknown>);
}

/** The options object of the Nth call to one job name. */
function optionsOf(name: string): Record<string, unknown>[] {
    return enqueueMock.mock.calls
        .filter((c) => c[0] === name)
        .map((c) => (c[2] ?? {}) as Record<string, unknown>);
}

describeFn('#3020 — a held person push becomes one 06:00 summary', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({
            data: { id: FARM, slug: FARM_SLUG, name: 'ЗК Тиха Нощ' },
        });
        for (const userId of [HELD, NO_DEVICE]) {
            const email = `${userId}@example.test`;
            await prisma.user.create({
                data: {
                    id: userId,
                    email,
                    emailHash: hashForLookup(email),
                    // The RECIPIENT's language, which the summary must use.
                    uiLanguage: 'bg',
                },
            });
            await prisma.tenantMembership.create({
                data: { tenantId: FARM, userId, role: 'EDITOR', status: 'ACTIVE' },
            });
        }
        // Only HELD has a device. `PushSubscription.tenantId` is NOT NULL,
        // which is itself why a tenantless event needed its own store.
        await prisma.pushSubscription.create({
            data: {
                tenantId: FARM,
                userId: HELD,
                platform: 'WEB',
                endpoint: `https://push.example.test/${randomUUID()}`,
                p256dh: 'k',
                auth: 'a',
            },
        });
    });

    afterAll(async () => {
        jest.useRealTimers();
        await prisma.personPushDeferral.deleteMany({
            where: { recipientUserId: { in: [HELD, NO_DEVICE] } },
        });
        await prisma.pushSubscription.deleteMany({ where: { userId: { in: [HELD, NO_DEVICE] } } });
        await prisma.tenantMembership.deleteMany({
            where: { userId: { in: [HELD, NO_DEVICE] } },
        });
        await prisma.user.deleteMany({ where: { id: { in: [HELD, NO_DEVICE] } } });
        await prisma.tenant.deleteMany({ where: { id: FARM } });
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        enqueueMock.mockClear();
        jest.useRealTimers();
        await prisma.personPushDeferral.deleteMany({
            where: { recipientUserId: { in: [HELD, NO_DEVICE] } },
        });
    });

    async function send(userId: string, subject: PersonPushSubject | undefined) {
        const { runPersonPushSend } = await import('@/app-layer/jobs/person-push-send');
        return runPersonPushSend({
            recipientUserId: userId,
            title: 'т',
            body: 'б',
            farmRelativePath: '/channels/c/posts/p',
            collapseKey: `ck-${randomUUID()}`,
            // Typed, not cast: the discriminated union is the contract both
            // producers satisfy, so driving it as `any` here would let this
            // suite pass against a shape they cannot produce.
            subject,
        });
    }

    describe('inside the window', () => {
        it('writes a deferral row and schedules ONE summary, sending nothing', async () => {
            fakeNow(INSIDE);
            const nightKey = quietNightKey(INSIDE);
            expect(nightKey).not.toBeNull();

            const r = await send(HELD, {
                kind: 'CHANNEL_MENTION', channelId: 'ch-1', postId: 'po-1',
            });

            // Nothing was sent — that is the hold.
            expect(r).toEqual({ attempted: 0, delivered: 0 });

            const rows = await prisma.personPushDeferral.findMany({
                where: { recipientUserId: HELD },
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                kind: 'CHANNEL_MENTION',
                channelId: 'ch-1',
                postId: 'po-1',
                conversationId: null,
                nightKey,
                // UNSETTLED: the person is still owed an interruption.
                settledAt: null,
            });

            const opts = optionsOf('person-push-summary');
            expect(opts).toHaveLength(1);
            expect(opts[0]!.jobId).toBe(`person-push-summary:${HELD}:${nightKey}`);
            // Scheduled forward to 06:00, not immediately.
            expect(opts[0]!.delay as number).toBeGreaterThan(0);
        }, 60_000);

        it('uses the SAME jobId for a second mention of the same night', async () => {
            fakeNow(INSIDE);
            const nightKey = quietNightKey(INSIDE);

            await send(HELD, { kind: 'CHANNEL_MENTION', channelId: 'ch-1', postId: 'po-1' });
            await send(HELD, { kind: 'CHANNEL_REPLY', channelId: 'ch-1', postId: 'po-2' });

            // TWO rows — both are owed, and the summary counts them.
            expect(await prisma.personPushDeferral.count({
                where: { recipientUserId: HELD },
            })).toBe(2);

            // ONE job id, twice. The dedupe itself is BullMQ's (see the
            // header); what this file owns is that the key is stable.
            const ids = optionsOf('person-push-summary').map((o) => o.jobId);
            expect(ids).toHaveLength(2);
            expect(new Set(ids).size).toBe(1);
            expect(ids[0]).toBe(`person-push-summary:${HELD}:${nightKey}`);
        }, 60_000);

        it('still holds a push whose payload predates the subject field', async () => {
            fakeNow(INSIDE);
            // The deploy window: an in-flight payload from the previous image.
            // It is COUNTED and linkless rather than dropped, which is the
            // several-items behaviour and strictly better than the drop this
            // replaced.
            await send(HELD, undefined);

            const rows = await prisma.personPushDeferral.findMany({
                where: { recipientUserId: HELD },
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]!.channelId).toBeNull();
            expect(rows[0]!.postId).toBeNull();
        }, 60_000);
    });

    describe('outside the window', () => {
        it('writes NO deferral row', async () => {
            fakeNow(OUTSIDE);
            expect(quietNightKey(OUTSIDE)).toBeNull();

            await send(HELD, {
                kind: 'CHANNEL_MENTION', channelId: 'ch-1', postId: 'po-1',
            });

            // The POSITIVE control for the window: the same call inside it
            // wrote a row, so this asserts the window decides rather than the
            // code never writing one.
            expect(await prisma.personPushDeferral.count({
                where: { recipientUserId: HELD },
            })).toBe(0);
            expect(optionsOf('person-push-summary')).toHaveLength(0);
        }, 60_000);
    });

    describe('the 06:00 summary', () => {
        async function runSummary(userId: string) {
            const { runPersonPushSummary } = await import('@/app-layer/jobs/person-push-summary');
            return runPersonPushSummary({ recipientUserId: userId, nightKey: '2026-11-14' });
        }

        async function hold(userId: string, data: Record<string, unknown>) {
            await prisma.personPushDeferral.create({
                data: {
                    recipientUserId: userId,
                    nightKey: '2026-11-14',
                    ...data,
                } as never,
            });
        }

        it('links to the ONE held item when there is exactly one', async () => {
            fakeNow(OUTSIDE);
            await hold(HELD, { kind: 'CHANNEL_MENTION', channelId: 'ch-9', postId: 'po-9' });

            const r = await runSummary(HELD);
            expect(r).toEqual({ count: 1, delivered: 1 });

            const sends = enqueuedOf('person-push-send');
            expect(sends).toHaveLength(1);
            // The five-segment permalink #3030 built, composed from the row's
            // pieces rather than replayed from a stored path.
            expect(sends[0]!.farmRelativePath).toBe('/channels/ch-9/posts/po-9');
            // The RECIPIENT's language — `uiLanguage: 'bg'`.
            expect(String(sends[0]!.body)).toContain('Нови през нощта: 1');

            // Settled, so tomorrow does not re-summarise it.
            expect(await prisma.personPushDeferral.count({
                where: { recipientUserId: HELD, settledAt: null },
            })).toBe(0);
        }, 60_000);

        it('sends NO link when several items are held', async () => {
            fakeNow(OUTSIDE);
            await hold(HELD, { kind: 'CHANNEL_MENTION', channelId: 'ch-9', postId: 'po-9' });
            await hold(HELD, { kind: 'DIRECT_MESSAGE', conversationId: 'cv-1' });

            const r = await runSummary(HELD);
            expect(r).toEqual({ count: 2, delivered: 1 });

            const sends = enqueuedOf('person-push-send');
            expect(sends).toHaveLength(1);
            // The owner's rule: no destination is invented for a mixed night.
            expect(sends[0]!.farmRelativePath).toBeNull();
            expect(String(sends[0]!.body)).toContain('Нови през нощта: 2');
        }, 60_000);

        it('links to the conversation when the one item is a direct message', async () => {
            fakeNow(OUTSIDE);
            await hold(HELD, { kind: 'DIRECT_MESSAGE', conversationId: 'cv-7' });

            await runSummary(HELD);
            expect(enqueuedOf('person-push-send')[0]!.farmRelativePath)
                .toBe('/exchange/threads/dm/cv-7');
        }, 60_000);

        it('sends nothing when the person holds no device, and SETTLES the rows', async () => {
            fakeNow(OUTSIDE);
            await hold(NO_DEVICE, { kind: 'CHANNEL_MENTION', channelId: 'ch-1', postId: 'po-1' });

            const r = await runSummary(NO_DEVICE);
            expect(r).toEqual({ count: 1, delivered: 0 });
            expect(enqueuedOf('person-push-send')).toHaveLength(0);

            // SETTLED although nothing was sent: nothing will ever deliver
            // these, and every later run would reach the same conclusion while
            // the rows accumulated. This is why the column is not called
            // `deliveredAt`.
            expect(await prisma.personPushDeferral.count({
                where: { recipientUserId: NO_DEVICE, settledAt: null },
            })).toBe(0);
        }, 60_000);

        it('sends nothing when there is nothing held', async () => {
            fakeNow(OUTSIDE);
            const r = await runSummary(HELD);
            expect(r).toEqual({ count: 0, delivered: 0 });
            expect(enqueuedOf('person-push-send')).toHaveLength(0);
        }, 60_000);

        it('leaves rows UNSETTLED when the run lands back inside the window', async () => {
            // A backlog of eight hours or more. The farm sibling drops this
            // case because its rows are still in the bell; a tenantless event
            // writes no bell row, so dropping would be the only loss of the
            // interruption — these rows wait for the next summary instead.
            fakeNow(INSIDE);
            await hold(HELD, { kind: 'CHANNEL_MENTION', channelId: 'ch-1', postId: 'po-1' });

            const r = await runSummary(HELD);
            expect(r).toEqual({ count: 1, delivered: 0 });
            expect(enqueuedOf('person-push-send')).toHaveLength(0);
            expect(await prisma.personPushDeferral.count({
                where: { recipientUserId: HELD, settledAt: null },
            })).toBe(1);
        }, 60_000);
    });
});
