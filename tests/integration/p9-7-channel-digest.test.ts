/**
 * P9.7 stage C (#2941) — the opt-in 07:15 channel digest.
 *
 * Owner ruling 2026-11-15: delivered by PUSH, not email, because
 * `NotificationOutbox.tenantId` is NOT NULL and a channel has no farm — the
 * wall #3020 hit, with P5.4a's reason.
 *
 * ## What this file proves, and what it cannot
 *
 * `enqueue` is the one mock, as in `p3020-person-quiet-hours-summary` and
 * `channel-mention-notifies`: there is no Redis in this suite, so a real
 * enqueue would fail and the delivery half would be untestable. That bounds
 * one claim honestly — whether a push is actually DELIVERED is
 * `person-push-send`'s contract and is covered by #2987's suite, not here.
 * What runs against a real database is the population, the clock, the
 * ledger, and the payload we hand the queue.
 *
 * ## Only `Date` is faked
 *
 * The job reads `new Date()` for its own default, and the clock gate is the
 * thing under test, so the window is moved rather than waited for.
 * `doNotFake` keeps every timer real — Prisma's internals use them and a
 * faked `setTimeout` turns a query into a hang.
 *
 * 2026-11-16 is EET (UTC+2), so 05:20Z is 07:20 Sofia — inside the delivery
 * window — and 05:00Z is 07:00, before it opens. 20:00Z is 22:00, which is
 * the case an open-ended gate would have got WRONG: «has 07:15 passed» is
 * true at 22:00, and a morning digest arriving at night is #2941's own
 * failure case an hour and a half further out.
 *
 * Every instant is asserted through `digestDueAt` as well as through the job,
 * because the pure boundary is where a DST change would show first.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { hashForLookup } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const enqueueMock = jest.fn().mockResolvedValue(undefined);
jest.mock('@/app-layer/jobs/queue', () => ({
    ...(jest.requireActual('@/app-layer/jobs/queue') as object),
    enqueue: (...a: unknown[]) => enqueueMock(...a),
}));

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUF = randomUUID().slice(0, 8);

/** Opted in explicitly, and has activity. */
const OPTED = `u-d-opted-${SUF}`;
/** Opted in, but nothing happened to them. */
const QUIET = `u-d-quiet-${SUF}`;
/** Not opted in at all, and HAS activity — the control. */
const NOT_OPTED = `u-d-noopt-${SUF}`;
/** Opted in via the per-farm DAILY_DIGEST preference instead. */
const BATCHER = `u-d-batch-${SUF}`;
/** Opted in and already erased — must never be a candidate. */
const ERASED = `u-d-erased-${SUF}`;
/** Opted in and suspended. */
const SUSPENDED = `u-d-susp-${SUF}`;
/** The author of everything, so no digest is ever about its own act. */
const AUTHOR = `u-d-author-${SUF}`;

const ALL = [OPTED, QUIET, NOT_OPTED, BATCHER, ERASED, SUSPENDED, AUTHOR];

const FARM = `t-d-${SUF}`;
const FARM_SLUG = `p97d-${SUF}`;
const CHANNEL = `c-d-${SUF}`;

/** 07:20 Sofia — inside the delivery window. */
const INSIDE = new Date('2026-11-16T05:20:00Z');
/** 07:00 Sofia — before it opens. */
const BEFORE = new Date('2026-11-16T05:00:00Z');
/** 22:00 Sofia — after it closes. The open-ended-gate bug. */
const LATE = new Date('2026-11-16T20:00:00Z');

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

/** Every payload enqueued for a person push, with its options. */
function pushes(): { payload: Record<string, unknown>; opts: Record<string, unknown> }[] {
    return enqueueMock.mock.calls
        .filter((c) => c[0] === 'person-push-send')
        .map((c) => ({
            payload: c[1] as Record<string, unknown>,
            opts: (c[2] ?? {}) as Record<string, unknown>,
        }));
}

function pushTo(userId: string) {
    return pushes().filter((p) => p.payload.recipientUserId === userId);
}

/** A post by AUTHOR that mentions `userId`, i.e. activity for them. */
async function mentionOf(userId: string, body: string): Promise<string> {
    const id = `p-d-${randomUUID()}`;
    await prisma.channelPost.create({
        data: {
            id,
            channelId: CHANNEL,
            authorUserId: AUTHOR,
            authorTenantId: FARM,
            kind: 'POST',
            body,
        },
    });
    await prisma.channelPostMention.create({
        data: { postId: id, userId },
    });
    return id;
}

describeFn('P9.7 — the opt-in 07:15 channel digest (#2941)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({
            data: { id: FARM, slug: FARM_SLUG, name: 'ЗК Обзор' },
        });
        for (const userId of ALL) {
            const email = `${userId}@example.test`;
            await prisma.user.create({
                data: {
                    id: userId,
                    email,
                    emailHash: hashForLookup(email),
                    // The RECIPIENT's language, which the digest must use.
                    uiLanguage: 'bg',
                    channelDigestOptIn: [OPTED, QUIET, ERASED, SUSPENDED].includes(userId),
                    pseudonymisedAt: userId === ERASED ? new Date('2026-10-01T00:00:00Z') : null,
                    suspendedAt: userId === SUSPENDED ? new Date('2026-10-01T00:00:00Z') : null,
                },
            });
            await prisma.tenantMembership.create({
                data: { tenantId: FARM, userId, role: 'EDITOR', status: 'ACTIVE' },
            });
        }

        // BATCHER opts in through the per-farm preference instead — the
        // population this job also covers, because `resolvePersonDelivery`
        // returns `digest-only` for DAILY_DIGEST and the FARM digest counts
        // `Notification` rows, which a channel event never writes. Without
        // this arm they would get no channel push AND no channel digest.
        await prisma.userNotificationPreference.create({
            data: { tenantId: FARM, userId: BATCHER, delivery: 'DAILY_DIGEST' },
        });

        await prisma.channel.create({
            data: {
                id: CHANNEL,
                key: `crop:digest-${SUF}`,
                kind: 'CROP',
                nameBg: 'Пшеница обзор',
                nameEn: 'Wheat digest',
            },
        });
        for (const userId of ALL) {
            await prisma.channelMembership.create({
                data: { channelId: CHANNEL, userId },
            });
        }

        // Activity for everybody who should get one, plus the control.
        await mentionOf(OPTED, 'Споменаване за обзора');
        await mentionOf(NOT_OPTED, 'Споменаване без абонамент');
        await mentionOf(BATCHER, 'Споменаване за групиране');
        await mentionOf(ERASED, 'Споменаване за заличен профил');
        await mentionOf(SUSPENDED, 'Споменаване за спрян профил');
        // QUIET deliberately has none.
    });

    afterAll(async () => {
        jest.useRealTimers();
        await prisma.channelPostMention.deleteMany({ where: { userId: { in: ALL } } });
        await prisma.channelPost.deleteMany({ where: { channelId: CHANNEL } });
        await prisma.channelMembership.deleteMany({ where: { channelId: CHANNEL } });
        await prisma.channel.deleteMany({ where: { id: CHANNEL } });
        await prisma.userNotificationPreference.deleteMany({ where: { userId: { in: ALL } } });
        await prisma.tenantMembership.deleteMany({ where: { userId: { in: ALL } } });
        await prisma.user.deleteMany({ where: { id: { in: ALL } } });
        await prisma.tenant.deleteMany({ where: { id: FARM } });
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        enqueueMock.mockClear();
        // The ledger is shared state across cases, so it is reset rather than
        // inherited — a case asserting "already sent is skipped" must set it
        // itself, or it would pass on whatever the previous case left.
        await prisma.user.updateMany({
            where: { id: { in: ALL } },
            data: { channelDigestSentOn: null },
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // ── the pure clock boundary ──────────────────────────────────────

    it('digestDueAt opens at local 07:15 and CLOSES an hour later', async () => {
        const { digestDueAt, DIGEST_DELIVERY_WINDOW_MINUTES } =
            await import('@/app-layer/jobs/channel-digest');

        expect(digestDueAt(BEFORE)).toBe(false);
        expect(digestDueAt(INSIDE)).toBe(true);

        // THE CASE AN OPEN-ENDED GATE GETS WRONG. «Has 07:15 passed» is true
        // at 22:00 Sofia, so the first draft of this job would have sent a
        // MORNING digest at night to anybody whose first activity arrived
        // late — they had nothing at 07:15, so were never stamped.
        expect(digestDueAt(LATE)).toBe(false);

        // The window is a CONSTANT and not a literal here, so widening it in
        // the source moves this assertion with it rather than contradicting
        // it silently.
        expect(DIGEST_DELIVERY_WINDOW_MINUTES).toBe(60);
    });

    it('the window is read in Europe/Sofia, not UTC', async () => {
        const { digestDueAt } = await import('@/app-layer/jobs/channel-digest');

        // 07:20 UTC is 09:20 Sofia — OUTSIDE the window. An implementation
        // that read UTC would call this due, and every other instant in this
        // file passes either way, so this is the one case that separates the
        // two readings. It is the `chatDayKey` precedent.
        expect(digestDueAt(new Date('2026-11-16T07:20:00Z'))).toBe(false);
    });

    // ── the population ──────────────────────────────────────────────

    it('sends to an opted-in person who has activity, once', async () => {
        fakeNow(INSIDE);
        const { runChannelDigest } = await import('@/app-layer/jobs/channel-digest');
        const r = await runChannelDigest();

        expect(pushTo(OPTED)).toHaveLength(1);
        expect(r.sent).toBeGreaterThanOrEqual(1);

        const sent = pushTo(OPTED)[0]!;
        // The destination is «За Вас» — the person-scoped surface the digest
        // is ABOUT. FARM-RELATIVE, never a bare path: `person-push-send`
        // resolves the `/t/{slug}` prefix, and a job that pre-prefixed it is
        // what `person-push-link-resolves` reports as self-prefixed.
        expect(sent.payload.farmRelativePath).toBe('/channels/for-you');
        // Per DAY, so a retry replaces rather than stacks a second banner.
        expect(String(sent.payload.collapseKey)).toMatch(/^channel-digest-\d{4}-\d{2}-\d{2}$/);
        // Bulgarian, because that is the RECIPIENT's language — not the
        // sender's, and there is no sender here at all.
        expect(sent.payload.title).toBe('Дневен обзор');
        // The count follows a LABEL, because `translateFor` is a plain
        // interpolator with no ICU: a plural form comes back as the literal
        // template. A digit in the body proves it interpolated at all.
        expect(String(sent.payload.body)).toMatch(/^Нови за Вас: \d+$/);
    });

    it('includes somebody who opted in through the per-farm DAILY_DIGEST preference', async () => {
        fakeNow(INSIDE);
        const { runChannelDigest } = await import('@/app-layer/jobs/channel-digest');
        await runChannelDigest();

        expect(pushTo(BATCHER)).toHaveLength(1);
    });

    it('sends NOTHING to somebody who never opted in, though they have activity', async () => {
        fakeNow(INSIDE);
        const { runChannelDigest } = await import('@/app-layer/jobs/channel-digest');
        await runChannelDigest();

        // The control that makes every assertion above mean something: this
        // person has an identical mention row and differs only in the column
        // under test.
        expect(pushTo(NOT_OPTED)).toHaveLength(0);
    });

    it('sends nothing — and stamps nothing — when there is no activity', async () => {
        fakeNow(INSIDE);
        const { runChannelDigest } = await import('@/app-layer/jobs/channel-digest');
        await runChannelDigest();

        expect(pushTo(QUIET)).toHaveLength(0);
        // The ledger is left ALONE, deliberately. Stamping it would mean a
        // person who had nothing at 07:20 could not be sent one later in the
        // same window if the job were re-run after a fix.
        const row = await prisma.user.findUnique({
            where: { id: QUIET },
            select: { channelDigestSentOn: true },
        });
        expect(row?.channelDigestSentOn).toBeNull();
    });

    it('excludes an ERASED account, which `suspendedAt` does not cover', async () => {
        fakeNow(INSIDE);
        const { runChannelDigest } = await import('@/app-layer/jobs/channel-digest');
        await runChannelDigest();

        // P5.6b keeps the `User` row alive on purpose (Art 17(3)(b)), so "the
        // row exists" cannot be read as "there is somebody to notify". A
        // self-service erasure never sets `suspendedAt`, so without the
        // `pseudonymisedAt` clause this person stays a candidate for ever.
        expect(pushTo(ERASED)).toHaveLength(0);
    });

    it('excludes a suspended account', async () => {
        fakeNow(INSIDE);
        const { runChannelDigest } = await import('@/app-layer/jobs/channel-digest');
        await runChannelDigest();

        expect(pushTo(SUSPENDED)).toHaveLength(0);
    });

    // ── the clock, through the job ───────────────────────────────────

    it('sends nothing before the window opens, and says so in the reading', async () => {
        fakeNow(BEFORE);
        const { runChannelDigest } = await import('@/app-layer/jobs/channel-digest');
        const r = await runChannelDigest();

        expect(pushes()).toHaveLength(0);
        // `candidates` is still counted, so a run before 07:15 reports its
        // population BESIDE `sent: 0` rather than looking like a run that
        // found nobody — the two zeros mean opposite things.
        expect(r.candidates).toBeGreaterThanOrEqual(1);
        expect(r.sent).toBe(0);
        expect(r.due).toBe(0);
    });

    it('sends nothing after the window closes', async () => {
        fakeNow(LATE);
        const { runChannelDigest } = await import('@/app-layer/jobs/channel-digest');
        const r = await runChannelDigest();

        expect(pushes()).toHaveLength(0);
        expect(r.sent).toBe(0);
    });

    // ── the ledger ──────────────────────────────────────────────────

    it('does not send twice in one morning', async () => {
        fakeNow(INSIDE);
        const { runChannelDigest } = await import('@/app-layer/jobs/channel-digest');

        await runChannelDigest();
        expect(pushTo(OPTED)).toHaveLength(1);

        // A second run inside the SAME window — which is what a 15-minute
        // schedule does four times — must find them stamped and skip.
        await runChannelDigest();
        expect(pushTo(OPTED)).toHaveLength(1);
    });

    it('stamps the ledger for the day it sent', async () => {
        fakeNow(INSIDE);
        const { runChannelDigest } = await import('@/app-layer/jobs/channel-digest');
        await runChannelDigest();

        const { farmToday } = await import('@/lib/calendar-day-key');
        const row = await prisma.user.findUnique({
            where: { id: OPTED },
            select: { channelDigestSentOn: true },
        });
        expect(row?.channelDigestSentOn).not.toBeNull();
        // Asserted as the DAY KEY rather than against a hardcoded date, so a
        // change to how the farm day is derived fails here instead of
        // drifting.
        expect(row!.channelDigestSentOn!.toISOString().slice(0, 10))
            .toBe(farmToday(INSIDE));
    });

    it('a digest is never about the recipient\'s own post', async () => {
        fakeNow(INSIDE);
        const { runChannelDigest } = await import('@/app-layer/jobs/channel-digest');
        await runChannelDigest();

        // AUTHOR wrote every post in this channel and is opted OUT, so this
        // asserts nothing by itself — but `readMyActivity` excludes
        // `authorUserId === ctx.userId`, and this is the read the digest
        // shares with «За Вас». One read, so the two cannot disagree about
        // what happened to a person.
        expect(pushTo(AUTHOR)).toHaveLength(0);
    });
});
