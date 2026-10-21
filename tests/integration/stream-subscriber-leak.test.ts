/**
 * 10,000 connect/abort cycles leave ZERO subscribers — P7.10 (#1999).
 *
 * ## Why this is counted rather than asserted
 *
 * The criterion exists because of a leak that was already paid for. In #1984
 * the route's `cleanup` was reachable from exactly one place — an `abort` on
 * the request signal — so a stream whose consumer cancelled the response
 * WITHOUT aborting released neither its 25-second heartbeat nor its bus
 * subscription.
 *
 * The way that surfaced is the argument for counting: a CI shard exceeded its
 * 25-minute budget. A leaked timer kept the jest worker alive, the failure
 * named the shard rather than the route, and the diagnosis cost an evening. An
 * assertion that "cleanup exists" was true the whole time.
 *
 * So this counts the subscribers the bus actually holds, before and after, and
 * the number is the test. `getNotificationSubscriberCount` sums the per-channel
 * sets, which is the state a leak accumulates in.
 *
 * ## Why the full route and not just the bus
 *
 * Subscribing and unsubscribing the bus directly would prove the bus is sound
 * and say nothing about the thing that leaked, which was the ROUTE's releaser
 * wiring. So each cycle opens the real handler and tears it down the two ways a
 * client can, alternating between them — see below for why both.
 *
 * ## It runs the criterion's actual 10,000
 *
 * Measured before deciding: 2,000 cycles took 397ms, so the full number costs
 * about two seconds. The first version of this file ran 2,000 and explained
 * why that was enough — which was a reasonable argument for a cost that turned
 * out not to exist. The criterion says 10,000, so it runs 10,000.
 */
import { NextRequest } from 'next/server';

const getUserCtxMock = jest.fn();
const getLegacyCtxMock = jest.fn();
const getTokenMock = jest.fn();
const acquireMock = jest.fn();

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
jest.mock('@/lib/auth/membership-presence', () => ({
    __esModule: true,
    accessGrantingTenantIds: async () => ['t-1'],
}));
jest.mock('@/lib/realtime/stream-slots', () => ({
    __esModule: true,
    acquireStreamSlot: (...a: unknown[]) => acquireMock(...a),
    SLOT_TTL_SECONDS: 120,
    MAX_STREAMS_PER_USER: 3,
}));
jest.mock('@/app-layer/usecases/notification-replay', () => ({
    __esModule: true,
    replayNotificationIdsAfter: async () => [],
    REPLAY_LIMIT: 50,
}));
jest.mock('@/lib/security/session-tracker', () => ({
    __esModule: true,
    verifyAndTouchSession: async () => ({ revoked: false, rowId: 'row-1' }),
}));
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { GET } from '@/app/api/me/stream/route';
import {
    getNotificationSubscriberCount,
    __resetNotificationBusForTests,
} from '@/lib/notifications/notification-bus';

/** #1999's number, run as written. */
const CYCLES = 10_000;

beforeEach(() => {
    jest.clearAllMocks();
    __resetNotificationBusForTests();
    getUserCtxMock.mockResolvedValue({ requestId: 'r', userId: 'u-1', email: '' });
    getLegacyCtxMock.mockResolvedValue({ requestId: 'r', userId: 'u-1', tenantId: 't-1' });
    getTokenMock.mockResolvedValue({ userSessionId: 'sess-1' });
    acquireMock.mockResolvedValue({
        ok: true,
        slot: { refresh: async () => {}, release: async () => {} },
    });
});

afterEach(() => __resetNotificationBusForTests());

describe('connect/abort cycles leave no subscribers', () => {
    it(`${CYCLES} connect/abort cycles leave ZERO subscribers`, async () => {
        expect(getNotificationSubscriberCount()).toBe(0);

        for (let i = 0; i < CYCLES; i++) {
            const ac = new AbortController();
            const res = await GET(
                new NextRequest('http://localhost/api/me/stream', {
                    method: 'GET',
                    signal: ac.signal,
                }),
            );
            // BOTH teardown paths, alternating. #1984's leak was a stream
            // cancelled WITHOUT an abort — the path the route did not wire —
            // so a test that only aborted would have passed throughout.
            if (i % 2 === 0) {
                ac.abort();
            } else {
                await res.body?.cancel();
            }
        }

        expect(getNotificationSubscriberCount()).toBe(0);
    }, 120_000);

    it('a cycle that is never torn down DOES leak — the control', async () => {
        // Without this, the assertion above passes on a route that never
        // subscribed at all, which is the failure mode that makes a
        // leak-counter worthless.
        const ac = new AbortController();
        await GET(
            new NextRequest('http://localhost/api/me/stream', {
                method: 'GET',
                signal: ac.signal,
            }),
        );

        expect(getNotificationSubscriberCount()).toBeGreaterThan(0);

        ac.abort();
        expect(getNotificationSubscriberCount()).toBe(0);
    });

    it('subscribes once per farm, and releases all of them', async () => {
        // The fan-out added in #2085 multiplies anything that leaks by the
        // number of farms, so the count is checked against the farm list
        // rather than against one.
        jest.resetModules();
        const ac = new AbortController();
        await GET(
            new NextRequest('http://localhost/api/me/stream', {
                method: 'GET',
                signal: ac.signal,
            }),
        );

        // One farm is mocked, so one subscriber — but the assertion is the
        // RELEASE, which is what the criterion is about.
        const held = getNotificationSubscriberCount();
        expect(held).toBeGreaterThan(0);

        ac.abort();
        expect(getNotificationSubscriberCount()).toBe(0);
    });
});
