/**
 * The notifications SSE channel is gated by a RUNTIME flag — #1982.
 *
 * ## Why this suite exists
 *
 * This route had no behavioural test at all, only source-reading guards
 * (`notif-sse-streaming-wiring`), and no flag gate. The gate lived in the
 * client on `NEXT_PUBLIC_NOTIFICATIONS_SSE`, which is inlined at BUILD time
 * and set in no Dockerfile `ARG` and no `ghcr-publish.yml` build-arg — so
 * every image baked it `undefined` and the channel was unreachable. Measured
 * in production 2026-10-16: zero requests to this route with a live tab, 15
 * requests started and 15 completed (an open stream would log a start with no
 * completion, so the absence is not a logging artefact).
 *
 * A client-side opt-in is not a feature flag either way. The endpoint stayed
 * authenticated-but-ungated, so "off" governed nothing except whether the UI
 * chose to connect.
 *
 * ## What this can and cannot assert
 *
 * It asserts what the ROUTE does: 204 and no bus subscriber when off, a live
 * `text/event-stream` when on. It cannot assert what a browser's `EventSource`
 * does with a 204 — that it fails the connection rather than reconnecting —
 * because jsdom does not implement `EventSource` (probed: `typeof EventSource
 * === 'undefined'`). That half is taken from the HTML spec and noted as such
 * in the route; asserting it wants an E2E spec in a real browser, and there is
 * no notification E2E spec yet.
 */
import { NextRequest } from 'next/server';

const isFeatureEnabledMock = jest.fn();
const getLegacyCtxMock = jest.fn();
const subscribeMock = jest.fn();

jest.mock('@/lib/feature-flags', () => ({
    __esModule: true,
    isFeatureEnabled: (...a: unknown[]) => isFeatureEnabledMock(...a),
}));
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getLegacyCtx: (...a: unknown[]) => getLegacyCtxMock(...a),
}));
jest.mock('@/lib/notifications/notification-bus', () => ({
    __esModule: true,
    subscribeToNotifications: (...a: unknown[]) => subscribeMock(...a),
}));

import { GET } from '@/app/api/notifications/stream/route';

/**
 * Every request carries an AbortController, and `afterEach` fires it.
 *
 * Not hygiene — this suite's first version omitted it and the consequence was
 * a 25-minute CI timeout. With the flag ON the route opens a live stream whose
 * `start()` registers a 25s heartbeat `setInterval`, and the only release was
 * an `abort` on the request signal. Nothing aborted, the timer outlived the
 * test, the jest worker never exited, and shard 4 of #1984 failed by exceeding
 * its budget. The failure named the shard, not this file, which is what makes
 * the class worth a comment: a leaked timer reports as a timeout somewhere
 * else entirely.
 *
 * The route now also releases on stream `cancel()`, so either path suffices.
 * Both are kept: this asserts the production path (abort) while the route's
 * own `cancel` covers the consumer that does not abort.
 */
const inFlight: AbortController[] = [];

const request = () => {
    const ac = new AbortController();
    inFlight.push(ac);
    return new NextRequest('http://localhost/api/notifications/stream', {
        method: 'GET',
        signal: ac.signal,
    });
};

describe('the notifications stream route', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getLegacyCtxMock.mockResolvedValue({ userId: 'u-1', tenantId: 't-1' });
        subscribeMock.mockReturnValue(() => {});
    });

    afterEach(() => {
        for (const ac of inFlight) ac.abort();
        inFlight.length = 0;
    });

    it('answers 204 with no body when the flag is off', async () => {
        isFeatureEnabledMock.mockResolvedValue(false);

        const res = await GET(request());

        expect(res.status).toBe(204);
        // Not an event stream: the browser must read this as "do not
        // reconnect", which a 200 text/event-stream would defeat.
        //
        // The `?? '(absent)'` is not defensive noise. A 204 carries no
        // content-type, so the bare `.not.toMatch` threw "received value must
        // be a string" — and the shape where it does NOT throw is worse: a
        // negated assertion over an empty value passes without testing
        // anything. The sentinel keeps the matcher on a real string so it
        // cannot pass vacuously, and names the state in the failure message.
        expect(res.headers.get('content-type') ?? '(absent)').not.toMatch(/event-stream/);
    });

    it('registers NO bus subscriber when the flag is off', async () => {
        // The load-bearing half. A gate that returns 204 after subscribing
        // would hold a listener per connection for a disabled channel, and
        // the status code alone cannot tell the two apart.
        isFeatureEnabledMock.mockResolvedValue(false);

        await GET(request());

        expect(subscribeMock).not.toHaveBeenCalled();
    });

    it('resolves the flag against the CALLER, not globally', async () => {
        // Cohorts make this matter: `FeatureFlag.cohorts` composes with
        // `enabled` as AND, so a flag can be on for some users only. Passing
        // null here would silently ignore cohort membership.
        isFeatureEnabledMock.mockResolvedValue(false);

        await GET(request());

        expect(isFeatureEnabledMock).toHaveBeenCalledWith('notifications.sse', 'u-1');
    });

    it('streams when the flag is on', async () => {
        isFeatureEnabledMock.mockResolvedValue(true);

        const res = await GET(request());

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
        // The proxy-buffering headers are what make SSE survive the real
        // deployment, so they are part of the contract rather than detail.
        expect(res.headers.get('cache-control')).toMatch(/no-transform/);
        expect(res.headers.get('x-accel-buffering')).toBe('no');
    });

    it('subscribes the caller tenant and user when the flag is on', async () => {
        isFeatureEnabledMock.mockResolvedValue(true);

        await GET(request());

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock.mock.calls[0][0]).toMatchObject({
            tenantId: 't-1',
            userId: 'u-1',
        });
    });

    it('releases the heartbeat and the subscription when the stream is CANCELLED', async () => {
        // The second way out of the stream, added with this suite because this
        // suite is what found it missing. `cleanup` was reachable only from an
        // `abort` on the request signal, so a consumer that cancels the
        // response without aborting left a 25s interval and a bus subscriber
        // alive per stream.
        //
        // Asserting on `unsubscribe` rather than on the timer: the returned
        // unsubscribe function is observable, a `setInterval` handle inside a
        // closure is not, and they are released by the same `cleanup` call.
        isFeatureEnabledMock.mockResolvedValue(true);
        const unsubscribe = jest.fn();
        subscribeMock.mockReturnValue(unsubscribe);

        const res = await GET(request());
        expect(unsubscribe).not.toHaveBeenCalled();

        await res.body!.cancel();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('authenticates BEFORE reading the flag', async () => {
        // Order matters: resolving a flag for an unauthenticated caller would
        // read the table on an anonymous request, and `getLegacyCtx` throwing
        // is what produces the 401 surface for this prefix.
        getLegacyCtxMock.mockRejectedValue(new Error('unauthenticated'));

        await expect(GET(request())).rejects.toThrow('unauthenticated');
        expect(isFeatureEnabledMock).not.toHaveBeenCalled();
    });
});
