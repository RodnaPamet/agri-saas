/**
 * The web-vitals sink accepts what `sendBeacon` actually sends — #1940.
 *
 * ## Why this suite did not exist, and why that is the story
 *
 * Nothing tested either end of the RUM chain. Measured in production over 30
 * days: 1857 requests logged, **zero** `web-vital` entries and zero requests
 * to `/api/metrics`. The pipeline is code-complete and has never produced a
 * single data point.
 *
 * It could sit like that because every failure path is silent by design. The
 * reporter wraps the beacon in `try {} catch {}` and discards `sendBeacon`'s
 * boolean; the sink wraps the parse in `try {} catch {}` and returns 204
 * regardless. Best-effort is right for a telemetry beacon — a visitor's page
 * must not break because a metric failed — but it means a DEAD channel and a
 * healthy one are indistinguishable from outside.
 *
 * So the first thing to establish is what the sink does with the exact bytes
 * a browser sends.
 *
 * ## `navigator.sendBeacon(url, string)` sends text/plain
 *
 * Not `application/json`. With a string payload the browser sets
 * `Content-Type: text/plain;charset=UTF-8`, and that is what reaches the
 * route. Whether `req.json()` tolerates it is a property of the runtime, not
 * something to assume in either direction — so it is asserted here.
 */
import { NextRequest } from 'next/server';

const loggerInfo = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        info: (...a: unknown[]) => loggerInfo(...a),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import { POST } from '@/app/api/metrics/route';

const beacon = (body: string, contentType?: string) =>
    new NextRequest('http://localhost/api/metrics', {
        method: 'POST',
        ...(contentType ? { headers: { 'content-type': contentType } } : {}),
        body,
    });

const LCP = JSON.stringify({ name: 'LCP', value: 3127.4, rating: 'needs-improvement', id: 'v4-1', navigationType: 'navigate' });

describe('the web-vitals sink', () => {
    beforeEach(() => jest.clearAllMocks());

    it('records a beacon sent as text/plain — what sendBeacon actually sends', async () => {
        // THE hypothesis for #1940. `navigator.sendBeacon(url, aString)` sets
        // `text/plain;charset=UTF-8`; if the route's `req.json()` refuses that,
        // the catch swallows it, the response is still 204, and the metric is
        // gone with nothing logged anywhere.
        const res = await POST(beacon(LCP, 'text/plain;charset=UTF-8'));
        expect(res.status).toBe(204);
        expect(loggerInfo).toHaveBeenCalledWith(
            'web-vital',
            expect.objectContaining({ metric: 'LCP', value: 3127.4 }),
        );
    });

    it('records a beacon sent as application/json — the fetch fallback path', async () => {
        // The reporter falls back to `fetch` with an explicit JSON content
        // type when `sendBeacon` is unavailable. Both paths must work, and a
        // suite covering only this one would have called the pipeline healthy.
        const res = await POST(beacon(LCP, 'application/json'));
        expect(res.status).toBe(204);
        expect(loggerInfo).toHaveBeenCalledWith('web-vital', expect.objectContaining({ metric: 'LCP' }));
    });

    it('records a beacon with NO content-type at all', async () => {
        const res = await POST(beacon(LCP));
        expect(res.status).toBe(204);
        expect(loggerInfo).toHaveBeenCalled();
    });

    it('ignores a malformed beacon without failing the request', async () => {
        // Fail-open is correct here: a browser posting rubbish must not get an
        // error, and must not be able to make the route throw.
        const res = await POST(beacon('not json at all', 'text/plain'));
        expect(res.status).toBe(204);
        expect(loggerInfo).not.toHaveBeenCalled();
    });

    it('ignores a beacon missing the fields it exists to record', async () => {
        const res = await POST(beacon(JSON.stringify({ rating: 'good' }), 'text/plain'));
        expect(res.status).toBe(204);
        expect(loggerInfo).not.toHaveBeenCalled();
    });
});
