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

    it('records the surface, so a p75 can be taken PER surface', async () => {
        // #1814. Without this the operator app and `/f/{handle}` land in one
        // pool, and P6.5's budget is about the public page alone.
        await POST(beacon(JSON.stringify({ name: 'LCP', value: 3127.4, surface: 'public-farm' })));
        expect(loggerInfo).toHaveBeenCalledWith(
            'web-vital',
            expect.objectContaining({ metric: 'LCP', surface: 'public-farm' }),
        );
    });

    it('DROPS an unrecognised surface rather than defaulting it', async () => {
        // The endpoint is public and unauthenticated, so an echoed value would
        // put anything a stranger posts into a log field. Dropping beats
        // defaulting to 'app': a default silently attributes a stranger's
        // beacon to a real surface, which corrupts the one question the field
        // exists to answer.
        await POST(beacon(JSON.stringify({ name: 'LCP', value: 1, surface: 'etc/passwd\n[level=50]' })));
        expect(loggerInfo).toHaveBeenCalledTimes(1);
        const logged = loggerInfo.mock.calls[0][1] as Record<string, unknown>;
        expect(logged.surface).toBeUndefined();
        expect(logged.metric).toBe('LCP');
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

/**
 * #1964 — every logged field comes from a closed set.
 *
 * The route validated `surface` and echoed `rating`, `navigationType` and
 * `name` on nothing but a `typeof` check, from an unauthenticated public body
 * that is deliberately NOT rate-limited. Since #1940 those logs leave the VM,
 * so an unbounded field is billable ingest anyone can drive.
 *
 * The acceptance half of this suite is not padding: it is what stops the fix
 * from being a silent outage. A closed set that is missing a real value drops
 * genuine measurements and looks exactly like no traffic — the failure #1940
 * is about. So every member of every union the library declares is asserted
 * to survive, and the lists are derived from `Metric` in the route so a
 * `web-vitals` upgrade breaks the BUILD rather than the data.
 */
describe('the web-vitals sink only logs values from a closed set', () => {
    beforeEach(() => jest.clearAllMocks());

    const logged = () => loggerInfo.mock.calls[0][1] as Record<string, unknown>;

    // Exactly `Metric['name']` in web-vitals 5.x.
    it.each(['CLS', 'FCP', 'INP', 'LCP', 'TTFB'])('accepts the real metric %s', async (name) => {
        await POST(beacon(JSON.stringify({ name, value: 12.5 })));
        expect(loggerInfo).toHaveBeenCalledTimes(1);
        expect(logged().metric).toBe(name);
    });

    // Exactly `Metric['rating']`.
    it.each(['good', 'needs-improvement', 'poor'])('accepts the real rating %s', async (rating) => {
        await POST(beacon(JSON.stringify({ name: 'LCP', value: 1, rating })));
        expect(logged().rating).toBe(rating);
    });

    /**
     * Exactly `Metric['navigationType']` — SEVEN, not six. `soft-navigation`
     * is in the installed library and was missing from this issue's own
     * description, which is the drift a transcribed list invites and the
     * reason the route derives these from the type.
     */
    it.each([
        'navigate',
        'reload',
        'back-forward',
        'back-forward-cache',
        'prerender',
        'restore',
        'soft-navigation',
    ])('accepts the real navigationType %s', async (navigationType) => {
        await POST(beacon(JSON.stringify({ name: 'LCP', value: 1, navigationType })));
        expect(logged().navigationType).toBe(navigationType);
    });

    it('drops an unrecognised rating but keeps the measurement', async () => {
        await POST(beacon(JSON.stringify({ name: 'LCP', value: 42, rating: 'excellent' })));
        expect(loggerInfo).toHaveBeenCalledTimes(1);
        expect(logged().rating).toBeUndefined();
        // The value is still a real measurement — a bad annotation on a good
        // number must not cost the number.
        expect(logged()).toMatchObject({ metric: 'LCP', value: 42 });
    });

    it('drops an unrecognised navigationType but keeps the measurement', async () => {
        await POST(beacon(JSON.stringify({ name: 'LCP', value: 42, navigationType: 'teleport' })));
        expect(logged().navigationType).toBeUndefined();
        expect(logged().metric).toBe('LCP');
    });

    it('drops the WHOLE beacon when the metric name is not a known metric', async () => {
        // The asymmetry with `rating` above is deliberate: `name` is what the
        // measurement IS, so an unknown name leaves nothing to record.
        const res = await POST(beacon(JSON.stringify({ name: 'MY_METRIC', value: 42 })));
        expect(res.status).toBe(204);
        expect(loggerInfo).not.toHaveBeenCalled();
    });

    it('drops a long string rather than writing it to the log', async () => {
        // The ingest concern, stated as a test: `typeof === 'string'` bounds
        // no length, and this endpoint has no rate limit by design.
        const huge = 'A'.repeat(100_000);
        await POST(beacon(JSON.stringify({ name: 'LCP', value: 1, rating: huge, navigationType: huge })));
        expect(loggerInfo).toHaveBeenCalledTimes(1);
        const line = JSON.stringify(logged());
        expect(logged().rating).toBeUndefined();
        expect(logged().navigationType).toBeUndefined();
        // Asserted on the whole serialised line, not field by field: the point
        // is that NOTHING carried it through, including a field this test did
        // not think to name.
        expect(line).not.toContain('AAAA');
        expect(line.length).toBeLessThan(500);
    });

    it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
        'refuses the inherited key %s, which a plain lookup would admit',
        async (key) => {
            // `Object.hasOwn`, not `registry[value]`. With a bare index these
            // four are truthy on every object literal, so the registry would
            // answer "allowed" for exactly the attacker-chosen strings it
            // exists to refuse.
            await POST(beacon(JSON.stringify({ name: 'LCP', value: 1, rating: key, navigationType: key, surface: key })));
            expect(loggerInfo).toHaveBeenCalledTimes(1);
            expect(logged().rating).toBeUndefined();
            expect(logged().navigationType).toBeUndefined();
            expect(logged().surface).toBeUndefined();
        },
    );

    it('still answers 204 to every one of these', async () => {
        for (const body of [
            JSON.stringify({ name: 'NOPE', value: 1 }),
            JSON.stringify({ name: 'LCP', value: 'not a number' }),
            JSON.stringify({ name: 'LCP', value: Number.POSITIVE_INFINITY }),
            JSON.stringify({ name: 'LCP' }),
            'null',
            '[]',
        ]) {
            const res = await POST(beacon(body));
            expect(res.status).toBe(204);
        }
    });
});
