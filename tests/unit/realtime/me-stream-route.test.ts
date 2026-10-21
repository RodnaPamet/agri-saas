/**
 * `GET /api/me/stream` — the route's own behaviour (P7.2, #1991).
 *
 * `stream-slots` and `notification-replay` have their own suites; this one
 * covers what only the route decides: which refusals it makes, what the frames
 * look like, and when it closes a live stream.
 *
 * ## Every request aborts in `afterEach`, and that is not hygiene
 *
 * `notifications-stream-flag-gate.test.ts` records the cost of omitting it: an
 * open stream registers a 25s heartbeat `setInterval`, the timer outlived the
 * test, the jest worker never exited, and a CI shard failed by exceeding its
 * 25-minute budget — naming the shard, not the file. This route adds two more
 * intervals (the slot refresh and the session re-check), so the same omission
 * would be three leaks rather than one.
 *
 * ## What is NOT asserted here, and why
 *
 * That a browser treats 204 as "do not reconnect". jsdom implements no
 * `EventSource` (`typeof EventSource === 'undefined'`), so that half is taken
 * from the HTML specification and recorded as such in the route. Asserting it
 * wants an E2E spec in a real browser.
 */
import { NextRequest } from 'next/server';

const isFeatureEnabledMock = jest.fn();
const getUserCtxMock = jest.fn();
const getLegacyCtxMock = jest.fn();
const getTokenMock = jest.fn();
const subscribeMock = jest.fn();
const acquireMock = jest.fn();
const replayMock = jest.fn();
const verifySessionMock = jest.fn();
/**
 * The farms the person belongs to — #2085.
 *
 * Read through the unscoped client because `TenantMembership` is the table
 * that answers "which tenants may I see", so scoping that read to one tenant
 * would be circular.
 */
let membershipRows: Array<{ tenantId: string }> = [];
const warn = jest.fn();
const info = jest.fn();

jest.mock('@/lib/feature-flags', () => ({
    __esModule: true,
    isFeatureEnabled: (...a: unknown[]) => isFeatureEnabledMock(...a),
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
jest.mock('@/lib/notifications/notification-bus', () => ({
    __esModule: true,
    subscribeToNotifications: (...a: unknown[]) => subscribeMock(...a),
}));
jest.mock('@/lib/realtime/stream-slots', () => ({
    __esModule: true,
    acquireStreamSlot: (...a: unknown[]) => acquireMock(...a),
    SLOT_TTL_SECONDS: 120,
    MAX_STREAMS_PER_USER: 3,
}));
jest.mock('@/app-layer/usecases/notification-replay', () => ({
    __esModule: true,
    replayNotificationIdsAfter: (...a: unknown[]) => replayMock(...a),
    REPLAY_LIMIT: 50,
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenantMembership: { findMany: async () => membershipRows } },
    prisma: { tenantMembership: { findMany: async () => membershipRows } },
}));
jest.mock('@/lib/security/session-tracker', () => ({
    __esModule: true,
    verifyAndTouchSession: (...a: unknown[]) => verifySessionMock(...a),
}));
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        warn: (...a: unknown[]) => warn(...a),
        info: (...a: unknown[]) => info(...a),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

import { GET } from '@/app/api/me/stream/route';

const SESSION_RECHECK_MS = 5 * 60_000;

const inFlight: AbortController[] = [];
const request = (headers?: Record<string, string>) => {
    const ac = new AbortController();
    inFlight.push(ac);
    return new NextRequest('http://localhost/api/me/stream', {
        method: 'GET',
        signal: ac.signal,
        headers,
    });
};

/** The release function the route handed to `subscribeToNotifications`. */
const releaseSlot = jest.fn();
const unsubscribe = jest.fn();

/** Read whatever is already buffered in the response body, without blocking. */
async function readFrames(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let out = '';
    // One read per enqueued chunk. `start` runs synchronously and the frames
    // below are enqueued before this is called, so a bounded loop with a race
    // against an already-resolved promise is enough — and must be bounded, or
    // a stream with nothing left to say would hang the test for ever.
    for (let i = 0; i < 20; i++) {
        const next = await Promise.race([
            reader.read(),
            new Promise<null>((r) => setTimeout(() => r(null), 0)),
        ]);
        if (!next || next.done) break;
        out += decoder.decode(next.value as Uint8Array);
    }
    reader.releaseLock();
    return out;
}

describe('GET /api/me/stream', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        isFeatureEnabledMock.mockResolvedValue(true);
        getUserCtxMock.mockResolvedValue({ requestId: 'r-1', userId: 'u-1', email: 'a@b.c' });
        getLegacyCtxMock.mockResolvedValue({
            requestId: 'r-1',
            userId: 'u-1',
            tenantId: 't-1',
            tenantSlug: 'farm',
        });
        getTokenMock.mockResolvedValue({ userSessionId: 'sess-1' });
        acquireMock.mockResolvedValue({
            ok: true,
            slot: { refresh: jest.fn(async () => {}), release: releaseSlot },
        });
        subscribeMock.mockReturnValue(unsubscribe);
        replayMock.mockResolvedValue([]);
        membershipRows = [{ tenantId: 't-1' }];
        verifySessionMock.mockResolvedValue({ revoked: false, rowId: 'row-1' });
    });

    afterEach(() => {
        for (const ac of inFlight) ac.abort();
        inFlight.length = 0;
        jest.useRealTimers();
    });

    describe('the three refusals, all 204', () => {
        it('204 when realtime is off, with no slot taken and no subscriber', async () => {
            isFeatureEnabledMock.mockResolvedValue(false);

            const res = await GET(request());

            expect(res.status).toBe(204);
            // The load-bearing half. A gate that refuses AFTER subscribing
            // would hold a listener per connection for a disabled channel, and
            // the status alone cannot tell the two apart.
            expect(acquireMock).not.toHaveBeenCalled();
            expect(subscribeMock).not.toHaveBeenCalled();
            // `?? '(absent)'` keeps the negated matcher on a real string: a
            // 204 carries no content-type, and `.not.toMatch(undefined)` both
            // throws and — worse — would pass vacuously over an empty value.
            expect(res.headers.get('content-type') ?? '(absent)').not.toMatch(/event-stream/);
        });

        it('204 when the token carries no session lineage', async () => {
            // A stream that cannot be re-checked would be the one connection
            // that outlives a revocation, so it is refused rather than
            // admitted unverifiable.
            getTokenMock.mockResolvedValue({ sub: 'u-1' });

            const res = await GET(request());

            expect(res.status).toBe(204);
            expect(acquireMock).not.toHaveBeenCalled();
            expect(subscribeMock).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledWith('sse.no_session_lineage', expect.anything());
        });

        it('204 when the person is at capacity, with no subscriber', async () => {
            acquireMock.mockResolvedValue({ ok: false, reason: 'at-capacity' });

            const res = await GET(request());

            expect(res.status).toBe(204);
            expect(subscribeMock).not.toHaveBeenCalled();
        });
    });

    it('asks for a slot keyed on the PERSON, with no tenant term', async () => {
        // #1991 says "3 streams per user". Passing a tenant here is how that
        // becomes three per MEMBERSHIP — nine for somebody in three farms —
        // which is the defect this route's own path argues against.
        await GET(request());

        expect(acquireMock).toHaveBeenCalledTimes(1);
        expect(acquireMock.mock.calls[0][0]).toBe('u-1');
        expect(acquireMock.mock.calls[0]).toHaveLength(2);
    });

    it('authenticates the PERSON before resolving a tenant', async () => {
        // Order is load-bearing: `getUserCtx` is the only one of the two given
        // the request, so it is the only one that can refuse an API key
        // presented as a person credential. `getLegacyCtx` resolves a session
        // without looking at an Authorization header, so running it first
        // would answer the cookie's user to a request that presented a key.
        const order: string[] = [];
        getUserCtxMock.mockImplementation(async () => {
            order.push('person');
            return { requestId: 'r-1', userId: 'u-1', email: '' };
        });
        getLegacyCtxMock.mockImplementation(async () => {
            order.push('tenant');
            return { requestId: 'r-1', userId: 'u-1', tenantId: 't-1' };
        });

        await GET(request());

        expect(order).toEqual(['person', 'tenant']);
    });

    it('refuses before reading the flag when the person cannot be authenticated', async () => {
        getUserCtxMock.mockRejectedValue(new Error('API_KEY_NOT_PERSON_SCOPED'));

        await expect(GET(request())).rejects.toThrow('API_KEY_NOT_PERSON_SCOPED');
        expect(isFeatureEnabledMock).not.toHaveBeenCalled();
        expect(acquireMock).not.toHaveBeenCalled();
    });

    it('resolves the flag against the caller, not globally', async () => {
        // `FeatureFlag.cohorts` composes with `enabled` as AND, so a flag can
        // be on for some people only; passing null would ignore cohorts.
        await GET(request());

        expect(isFeatureEnabledMock).toHaveBeenCalledWith('notifications.sse', 'u-1');
    });

    it('streams with the headers that survive the real deployment', async () => {
        const res = await GET(request());

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
        expect(res.headers.get('cache-control')).toMatch(/no-transform/);
        expect(res.headers.get('x-accel-buffering')).toBe('no');
    });

    describe('frames', () => {
        it('emits an id: line, which is what makes replay possible at all', async () => {
            // The whole point of this route over `/api/notifications/stream`.
            // `EventSource` populates `Last-Event-ID` from `id:`, so a stream
            // without one can implement replay perfectly and never be asked.
            const res = await GET(request());
            const send = subscribeMock.mock.calls[0][0].send as (e: { id: string }) => void;

            send({ id: 'notif-42' });
            const body = await readFrames(res);

            expect(body).toMatch(/^id: notif-42$/m);
            expect(body).toMatch(
                /^data: \{"kind":"notification","id":"notif-42","tenantId":"t-1"\}$/m,
            );
            // `id:` BEFORE `data:` — a client that saw data first would
            // dispatch the event before the id was associated with it.
            expect(body.indexOf('id: notif-42')).toBeLessThan(body.indexOf('data:'));
        });
    });

    describe('replay', () => {
        it('replays nothing when the client sends no cursor', async () => {
            await GET(request());

            expect(replayMock).not.toHaveBeenCalled();
        });

        it('replays after the cursor the client echoed back', async () => {
            replayMock.mockResolvedValue([
                { id: 'old-1', tenantId: 't-1' },
                { id: 'old-2', tenantId: 't-1' },
            ]);

            const res = await GET(request({ 'last-event-id': 'cursor-1' }));
            // The replay is deliberately not awaited by the route, so let the
            // microtask queue drain before reading.
            await Promise.resolve();
            await Promise.resolve();
            const body = await readFrames(res);

            expect(replayMock).toHaveBeenCalledWith(
                expect.objectContaining({ tenantId: 't-1', userId: 'u-1' }),
                'cursor-1',
                ['t-1'],
            );
            expect(body).toMatch(/id: old-1/);
            expect(body).toMatch(/id: old-2/);
        });

        it('a live event that arrives mid-replay is sent AFTER the replayed ids', async () => {
            // The ordering property, and it needed the implementation to
            // change to be true. Starting the replay before `subscribe` does
            // not order anything: `subscribe` is synchronous, so the bus
            // subscription is live while the replay query is still in flight.
            //
            // The consequence is not untidiness. `EventSource` remembers the
            // LAST id it saw as `Last-Event-ID`, so a client whose newest
            // frame is an old replayed id carries a cursor that has moved
            // BACKWARDS, and its next reconnect replays from there again.
            let resolveReplay: (ids: Array<{ id: string; tenantId: string }>) => void = () => {};
            replayMock.mockReturnValue(
                new Promise<Array<{ id: string; tenantId: string }>>((r) => {
                    resolveReplay = r;
                }),
            );

            const res = await GET(request({ 'last-event-id': 'cursor-1' }));
            const send = subscribeMock.mock.calls[0][0].send as (e: { id: string }) => void;

            // Live, while the replay query has not come back yet.
            send({ id: 'live-1' });
            resolveReplay([
                { id: 'old-1', tenantId: 't-1' },
                { id: 'old-2', tenantId: 't-1' },
            ]);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            const body = await readFrames(res);
            expect(body).toMatch(/id: old-1/);
            expect(body).toMatch(/id: live-1/);
            expect(body.indexOf('id: old-1')).toBeLessThan(body.indexOf('id: live-1'));
            expect(body.indexOf('id: old-2')).toBeLessThan(body.indexOf('id: live-1'));
        });

        it('flushes buffered live events even when the replay FAILS', async () => {
            // Otherwise a failed backfill would also swallow every event that
            // arrived while it was failing — a client would be live, silent,
            // and have no way to know it had missed anything.
            let rejectReplay: (e: Error) => void = () => {};
            replayMock.mockReturnValue(
                new Promise<Array<{ id: string; tenantId: string }>>((_r, j) => {
                    rejectReplay = j;
                }),
            );

            const res = await GET(request({ 'last-event-id': 'cursor-1' }));
            const send = subscribeMock.mock.calls[0][0].send as (e: { id: string }) => void;

            send({ id: 'live-1' });
            rejectReplay(new Error('db down'));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(await readFrames(res)).toMatch(/id: live-1/);
        });

        it('does NOT buffer when there is no cursor to replay', async () => {
            // The control: with no `Last-Event-ID` there is no replay to wait
            // for, so a live event must go out immediately rather than sitting
            // in a buffer nothing will ever flush.
            const res = await GET(request());
            const send = subscribeMock.mock.calls[0][0].send as (e: { id: string }) => void;

            send({ id: 'live-1' });

            expect(await readFrames(res)).toMatch(/id: live-1/);
        });

        it('a failed replay does not stop the live subscription', async () => {
            // The ids are a hint either way: a client that receives none
            // refetches, which is what it does on a cold open. Losing the live
            // subscription because a backfill query failed would be the
            // expensive half of the same reconnect.
            replayMock.mockRejectedValue(new Error('db down'));

            await GET(request({ 'last-event-id': 'cursor-1' }));
            await Promise.resolve();
            await Promise.resolve();

            expect(subscribeMock).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith('sse.replay_failed', expect.anything());
        });
    });

    describe('the 5-minute session re-check', () => {
        it('closes the stream when the session has been revoked', async () => {
            jest.useFakeTimers();
            verifySessionMock.mockResolvedValue({ revoked: true, rowId: 'row-1' });

            const res = await GET(request());
            expect(unsubscribe).not.toHaveBeenCalled();

            await jest.advanceTimersByTimeAsync(SESSION_RECHECK_MS);

            expect(verifySessionMock).toHaveBeenCalledWith('sess-1');
            // Releasing is observable through the subscription's teardown; the
            // interval handles inside the closure are not, and the same
            // releaser clears both.
            expect(unsubscribe).toHaveBeenCalledTimes(1);
            expect(releaseSlot).toHaveBeenCalledTimes(1);
            expect(info).toHaveBeenCalledWith('sse.session_revoked', expect.anything());
            void res;
        });

        it('does NOT close a legacy session whose row is missing', async () => {
            // `verifyAndTouchSession` reports a missing row as NOT revoked, on
            // purpose, "so we don't lock legacy users out" — a token minted
            // before session tracking shipped has no row. Treating that as a
            // revocation here would close the streams of exactly those people,
            // turning a documented leniency into a per-connection lockout.
            jest.useFakeTimers();
            verifySessionMock.mockResolvedValue({ revoked: false, rowId: null });

            await GET(request());
            await jest.advanceTimersByTimeAsync(SESSION_RECHECK_MS);

            expect(verifySessionMock).toHaveBeenCalled();
            expect(unsubscribe).not.toHaveBeenCalled();
        });

        it('does NOT close the stream when the re-check itself fails', async () => {
            // A database briefly unreachable is not a revocation, and closing
            // on it would turn a blip into every client reconnecting at once.
            jest.useFakeTimers();
            verifySessionMock.mockRejectedValue(new Error('timeout'));

            await GET(request());
            await jest.advanceTimersByTimeAsync(SESSION_RECHECK_MS);

            expect(unsubscribe).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledWith('sse.session_recheck_failed', expect.anything());
        });

        it('has not re-checked before its period elapses', async () => {
            // The control for the three cases above: each advances time by one
            // period, and all of them would read identically if the interval
            // fired immediately.
            jest.useFakeTimers();

            await GET(request());
            await jest.advanceTimersByTimeAsync(SESSION_RECHECK_MS - 1);

            expect(verifySessionMock).not.toHaveBeenCalled();
        });
    });

    it('gives the slot back when the stream is cancelled', async () => {
        // The consumer that closes the response without aborting the request —
        // the path whose absence was leak 1 in #1991.
        const res = await GET(request());

        await res.body!.cancel();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(releaseSlot).toHaveBeenCalledTimes(1);
    });

    it('subscribes the active tenant and the calling person', async () => {
        await GET(request());

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock.mock.calls[0][0]).toMatchObject({
            tenantId: 't-1',
            userId: 'u-1',
        });
    });

    describe('every farm on one connection — #2085', () => {
        it('subscribes once per farm the person belongs to', async () => {
            // The point of the change. Delivery was scoped to the active farm
            // because a bare id gave a client no way to tell which farm a row
            // came from; the frame now carries `tenantId`, so one connection
            // can carry them all.
            membershipRows = [{ tenantId: 't-1' }, { tenantId: 't-2' }, { tenantId: 't-3' }];

            await GET(request());

            expect(subscribeMock).toHaveBeenCalledTimes(3);
            const tenants = subscribeMock.mock.calls.map((c) => c[0].tenantId);
            expect(new Set(tenants)).toEqual(new Set(['t-1', 't-2', 't-3']));
        });

        it('puts the ACTIVE farm first, which is what makes replay cheap', async () => {
            // The cursor is resolved per farm until found, and the farm a
            // client was last looking at is overwhelmingly where its last
            // event came from — so the common case costs one query, not N.
            membershipRows = [{ tenantId: 't-3' }, { tenantId: 't-1' }, { tenantId: 't-2' }];

            await GET(request({ 'last-event-id': 'cursor-1' }));

            expect(replayMock.mock.calls[0][2][0]).toBe('t-1');
        });

        it('lists each farm ONCE, even though the active one is also a membership', async () => {
            // The active tenant is prepended and is normally also in the
            // membership rows, so without the filter it would be subscribed
            // to twice — two bus subscriptions on one channel, and every
            // event delivered to the client twice.
            membershipRows = [{ tenantId: 't-1' }, { tenantId: 't-2' }];

            await GET(request());

            const tenants = subscribeMock.mock.calls.map((c) => c[0].tenantId);
            expect(tenants).toEqual(['t-1', 't-2']);
            expect(tenants).toHaveLength(new Set(tenants).size);
        });

        it('names the farm in every live frame', async () => {
            membershipRows = [{ tenantId: 't-1' }, { tenantId: 't-2' }];

            const res = await GET(request());
            // The second subscription is the second farm's.
            const sendForT2 = subscribeMock.mock.calls[1][0].send as (e: { id: string }) => void;
            sendForT2({ id: 'notif-from-t2' });
            const body = await readFrames(res);

            expect(body).toMatch(/"kind":"notification"/);
            expect(body).toMatch(/"id":"notif-from-t2"/);
            // The farm it came from, not the active one — which is the whole
            // reason a client can act on it.
            expect(body).toMatch(/"tenantId":"t-2"/);
        });

        it('releases EVERY farm subscription on cancel', async () => {
            // Three subscriptions and one releaser. Releasing only the first
            // would leak two per connection, which is the leak #1984 fixed in
            // the single-farm case.
            membershipRows = [{ tenantId: 't-1' }, { tenantId: 't-2' }, { tenantId: 't-3' }];
            const un1 = jest.fn();
            const un2 = jest.fn();
            const un3 = jest.fn();
            subscribeMock
                .mockReturnValueOnce(un1)
                .mockReturnValueOnce(un2)
                .mockReturnValueOnce(un3);

            const res = await GET(request());
            await res.body!.cancel();

            expect(un1).toHaveBeenCalledTimes(1);
            expect(un2).toHaveBeenCalledTimes(1);
            expect(un3).toHaveBeenCalledTimes(1);
        });

        it('still works for somebody with exactly one farm — the control', async () => {
            membershipRows = [{ tenantId: 't-1' }];

            await GET(request());

            expect(subscribeMock).toHaveBeenCalledTimes(1);
            expect(subscribeMock.mock.calls[0][0].tenantId).toBe('t-1');
        });
    });
});
