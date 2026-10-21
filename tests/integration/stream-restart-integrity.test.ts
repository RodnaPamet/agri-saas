/**
 * A restart during streaming loses 0 events — P7.10 (#1999).
 *
 * ## The criterion, and the half of it that was ruled on
 *
 * #1999 asks for "a restart during streaming loses 0 events and duplicates 0",
 * and names the tension itself: "losing nothing needs the SIGTERM drain (P7.3),
 * duplicating nothing needs `Last-Event-ID` replay to be exact rather than
 * generous. A replay that errs on the side of resending satisfies the first and
 * fails the second."
 *
 * The data decided it. `createdAt` is `timestamp(3)` and notifications arrive
 * in batches: measured in production on 2026-10-20, 8,778 of 8,815 rows (99.6%)
 * share their `(userId, createdAt)` with another row, in 399 groups, the
 * largest 22, produced by the LOW_STOCK sweep. A strict `>` cursor would tell
 * a client reconnecting on any member of a batch that nothing happened while
 * the other twenty-one were never mentioned again.
 *
 * So the replay takes the cursor's whole millisecond and excludes the cursor
 * row by id, and the owner's ruling was to keep it loss-free and restate the
 * criterion rather than trade a silent loss for a cheap duplicate. What this
 * file asserts is therefore:
 *
 *   - **0 lost, unconditionally** — every id created while the stream was down
 *     arrives on reconnect.
 *   - **0 duplicated except within the cursor's own millisecond** — and that
 *     bound is asserted, not assumed, including the case where the cursor has
 *     a same-millisecond sibling.
 *
 * ## Why this test exists when replay and drain are both already covered
 *
 * `notification-replay.test.ts` covers the query and `stream-drain.test.ts`
 * covers the releaser. Neither covers the composition, which is where the
 * restart actually lives: the bus is Redis pub/sub with NO retention, so an
 * event published while no stream is connected is gone from the bus by design.
 * The only thing that carries it across the restart is the row plus the
 * reconnect's cursor. A test of either half alone passes while that handover
 * is broken.
 *
 * Auth is mocked because auth is not what is under test; the DATABASE and the
 * replay are real, because "the database is the event log" is the claim.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';

const TAG = `restart-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${TAG}`;
let me = '';

const getUserCtxMock = jest.fn();
const getLegacyCtxMock = jest.fn();
const getTokenMock = jest.fn();

jest.mock('@/lib/feature-flags', () => ({
    __esModule: true,
    isFeatureEnabled: async () => true,
}));
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getUserCtx: (...a: unknown[]) => getUserCtxMock(...a),
    getLegacyCtx: (...a: unknown[]) => getLegacyCtxMock(...a),
}));
jest.mock('next-auth/jwt', () => ({
    __esModule: true,
    getToken: (...a: unknown[]) => getTokenMock(...a),
}));
jest.mock('@/lib/realtime/stream-slots', () => ({
    __esModule: true,
    acquireStreamSlot: async () => ({
        ok: true,
        slot: { refresh: async () => {}, release: async () => {} },
    }),
    SLOT_TTL_SECONDS: 120,
    MAX_STREAMS_PER_USER: 3,
}));
jest.mock('@/lib/security/session-tracker', () => ({
    __esModule: true,
    verifyAndTouchSession: async () => ({ revoked: false, rowId: 'row-1' }),
}));
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// The membership query is mocked to the one farm this suite creates. Deliberate
// scope: #2085's cross-farm fan-out has its own coverage in
// `notification-replay.test.ts`, and resolving it for real here would make a
// restart test fail for a membership reason.
jest.mock('@/lib/auth/membership-presence', () => ({
    __esModule: true,
    accessGrantingTenantIds: async () => [TENANT],
}));

import { GET } from '@/app/api/me/stream/route';
import {
    publishNotificationEvent,
    __resetNotificationBusForTests,
} from '@/lib/notifications/notification-bus';
import { drainOpenStreams } from '@/lib/realtime/stream-drain';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** Create a notification at a controlled time, so ordering is deterministic. */
async function notify(at: Date, title = 'n'): Promise<string> {
    const row = await prisma.notification.create({
        data: { tenantId: TENANT, userId: me, title, message: 'm', createdAt: at },
        select: { id: true },
    });
    return row.id;
}

interface OpenStream {
    ac: AbortController;
    res: Response;
    /** Ids seen so far, in arrival order, including repeats. */
    ids: string[];
    done: Promise<void>;
}

/**
 * Open the real handler and drain its body in the background, collecting every
 * SSE `id:` line. `serialiseFrame` emits `id:` only for notification frames, so
 * the listing tick and the heartbeat comment contribute nothing — which is what
 * makes this a count of notification ids rather than of frames.
 */
const opened: OpenStream[] = [];

async function open(lastEventId?: string): Promise<OpenStream> {
    const ac = new AbortController();
    const headers: Record<string, string> = {};
    if (lastEventId) headers['last-event-id'] = lastEventId;
    const res = await GET(
        new NextRequest('http://localhost/api/me/stream', {
            method: 'GET',
            signal: ac.signal,
            headers,
        }),
    );
    const ids: string[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const done = (async () => {
        let buffer = '';
        try {
            for (;;) {
                const { done: finished, value } = await reader.read();
                if (finished) break;
                buffer += decoder.decode(value, { stream: true });
                let nl: number;
                while ((nl = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, nl);
                    buffer = buffer.slice(nl + 1);
                    if (line.startsWith('id: ')) ids.push(line.slice(4).trim());
                }
            }
        } catch {
            // An aborted or drained stream rejects the pending read. That is
            // the close this test is about, not a failure.
        }
    })();
    const stream = { ac, res, ids, done };
    // Registered so `afterEach` tears it down even when an assertion throws
    // first. Without this a failing test leaves a live 25-second heartbeat and
    // jest hangs at exit rather than reporting — which is #1984's failure mode
    // reproduced inside the test written to catch it. Measured: a mutation run
    // took ten minutes to exit instead of fourteen seconds.
    opened.push(stream);
    return stream;
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until at least `n` ids have arrived.
 *
 * A microtask drain is NOT enough and the first version of this file used one:
 * the replay is a real database round-trip, so the frames arrive on an I/O
 * callback and every assertion read an empty array. Polling with a deadline is
 * what actually waits for it.
 */
async function waitForIds(s: OpenStream, n: number, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (s.ids.length < n) {
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for ${n} id(s); saw ${s.ids.length}: [${s.ids.join(', ')}]`,
            );
        }
        await tick();
    }
}

/**
 * A fixed grace period, used ONLY where the assertion is an ABSENCE.
 *
 * A poll-until-present loop cannot prove nothing arrives: its first check
 * passes immediately and the test is green before the server has had a chance
 * to send anything. So the control below waits a wall-clock period instead,
 * long enough that the replay — which the other cases measure at single-digit
 * milliseconds — would have landed.
 */
async function grace(): Promise<void> {
    await tick(500);
}

/**
 * Await a stream's close with a bound and a name.
 *
 * A bare `await s.done` detects a drain that closes nothing — by hanging until
 * jest's 60s per-test timeout, which in CI reads as a flake rather than as the
 * drain being broken. Measured with `drainOpenStreams` stubbed to a no-op:
 * 60,064ms and "Exceeded timeout" where this says what happened in five
 * seconds.
 */
async function expectClosedWithin(s: OpenStream, ms = 5_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), ms);
    });
    const outcome = await Promise.race([s.done.then(() => 'closed' as const), timeout]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
        throw new Error(
            `the stream was still open ${ms}ms after drainOpenStreams(). A restart ` +
                `that does not close its streams is the P7.3 half of this criterion.`,
        );
    }
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, name: TENANT, slug: TAG },
    });
    const email = `${TAG}@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    me = u.id;
    await prisma.tenantMembership.create({
        data: {
            tenantId: TENANT,
            userId: me,
            role: Role.ADMIN,
            status: MembershipStatus.ACTIVE,
        },
    });
}, 60_000);

beforeEach(() => {
    __resetNotificationBusForTests();
    jest.clearAllMocks();
    getUserCtxMock.mockResolvedValue({ requestId: 'r', userId: me, email: '' });
    getLegacyCtxMock.mockResolvedValue(
        makeRequestContext('ADMIN', { userId: me, tenantId: TENANT, tenantSlug: TAG }),
    );
    getTokenMock.mockResolvedValue({ userSessionId: 'sess-1' });
});

afterEach(async () => {
    for (const s of opened.splice(0)) {
        s.ac.abort();
        await s.done;
    }
    __resetNotificationBusForTests();
    if (!DB_AVAILABLE) return;
    await prisma.notification.deleteMany({ where: { tenantId: TENANT } });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.notification.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$disconnect();
});

describeFn('a restart during streaming', () => {
    const t0 = new Date('2026-10-20T10:00:00.000Z');
    const at = (ms: number) => new Date(t0.getTime() + ms);

    it('loses nothing published while the stream was down', async () => {
        // ── live, before the restart ──
        const a = await notify(t0, 'a');
        const first = await open();
        // The live event has to come after the (empty) replay has settled, or
        // the route's own buffer-until-replay-resolves would reorder it.
        await grace();
        publishNotificationEvent(TENANT, me, { id: a });
        await waitForIds(first, 1);
        expect(first.ids).toEqual([a]);

        // ── SIGTERM ──
        // The return value is the number of streams the drain closed, so a
        // drain that registered nothing fails here rather than at the far end.
        expect(drainOpenStreams()).toBeGreaterThan(0);
        await expectClosedWithin(first);

        // ── published with NOBODY connected. The bus is pub/sub with no
        //    retention, so these are gone from the bus the instant they are
        //    published; only the rows and the cursor carry them. ──
        const b = await notify(at(1000), 'b');
        const c = await notify(at(2000), 'c');
        publishNotificationEvent(TENANT, me, { id: b });
        publishNotificationEvent(TENANT, me, { id: c });

        // ── the client reconnects with what it last saw ──
        const second = await open(a);
        await waitForIds(second, 2);
        second.ac.abort();
        await second.done;

        expect(second.ids).toEqual([b, c]);
    }, 60_000);

    it('does not repeat the cursor itself', async () => {
        const a = await notify(t0, 'a');
        const b = await notify(at(1000), 'b');

        const s = await open(a);
        await waitForIds(s, 1);
        s.ac.abort();
        await s.done;

        expect(s.ids).toEqual([b]);
        expect(s.ids).not.toContain(a);
    }, 60_000);

    it('repeats ONLY the cursor millisecond, and that bound is the accepted cost', async () => {
        // The batch shape: three rows on one millisecond, which is the normal
        // case for the LOW_STOCK sweep rather than an edge case.
        const sib1 = await notify(t0, 'sib1');
        const sib2 = await notify(t0, 'sib2');
        const sib3 = await notify(t0, 'sib3');
        const later = await notify(at(5000), 'later');

        const s = await open(sib1);
        await waitForIds(s, 3);
        s.ac.abort();
        await s.done;

        // 0 LOST: both siblings the client had not seen, plus the later row.
        expect(s.ids).toContain(sib2);
        expect(s.ids).toContain(sib3);
        expect(s.ids).toContain(later);
        // The repeat is bounded to the cursor's millisecond: the cursor row
        // itself is excluded by id, and nothing outside that millisecond
        // repeats. With a strict `>` cursor this assertion would still pass
        // while the two siblings above were silently dropped — which is why
        // the loss assertions come first.
        expect(s.ids).not.toContain(sib1);
        expect(new Set(s.ids).size).toBe(s.ids.length);
    }, 60_000);

    it('CONTROL: a reconnect with NO cursor replays nothing, so the cursor is what carries the restart', async () => {
        // Without this, every assertion above would pass on a route that
        // simply sent every notification on open.
        await notify(t0, 'a');
        await notify(at(1000), 'b');

        const s = await open();
        await grace();
        s.ac.abort();
        await s.done;

        expect(s.ids).toEqual([]);
    }, 60_000);
});
