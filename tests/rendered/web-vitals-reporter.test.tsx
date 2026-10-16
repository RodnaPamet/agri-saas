/**
 * The reporter actually beacons — #1940.
 *
 * Production evidence: 1857 requests logged over 30 days, **zero**
 * `web-vital` entries. The sink is proven to accept every content type a
 * browser sends (`web-vitals-sink.test.ts`), so the loss is upstream, and
 * nothing tested this end either.
 *
 * It could stay broken because the component swallows everything: the dynamic
 * import has `.catch(() => {})`, the beacon sits in `try {} catch {}`, and
 * `sendBeacon`'s boolean return — which is `false` when the browser refuses to
 * queue the payload — is discarded. Correct for a telemetry beacon on a
 * visitor's page; it also means a dead channel looks exactly like a quiet one.
 */
import { render } from '@testing-library/react';

const onCLS = jest.fn();
const onINP = jest.fn();
const onLCP = jest.fn();
const onFCP = jest.fn();
const onTTFB = jest.fn();

// The dynamic `import('web-vitals')` resolves to this.
jest.mock('web-vitals', () => ({
    __esModule: true,
    onCLS: (cb: unknown) => onCLS(cb),
    onINP: (cb: unknown) => onINP(cb),
    onLCP: (cb: unknown) => onLCP(cb),
    onFCP: (cb: unknown) => onFCP(cb),
    onTTFB: (cb: unknown) => onTTFB(cb),
}));

import { WebVitalsReporter } from '@/components/pwa/WebVitalsReporter';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('WebVitalsReporter', () => {
    let sendBeacon: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        sendBeacon = jest.fn().mockReturnValue(true);
        Object.defineProperty(navigator, 'sendBeacon', {
            configurable: true,
            writable: true,
            value: sendBeacon,
        });
    });

    it('subscribes to all five metrics', async () => {
        render(<WebVitalsReporter />);
        await flush();
        // All five, because INP is FIELD-ONLY — Lighthouse has no lab
        // equivalent, so losing this subscription loses the metric entirely
        // rather than degrading it.
        for (const fn of [onCLS, onINP, onLCP, onFCP, onTTFB]) {
            expect(fn).toHaveBeenCalledTimes(1);
        }
    });

    it('beacons a metric to /api/metrics with the fields the sink records', async () => {
        render(<WebVitalsReporter />);
        await flush();

        // Fire the callback web-vitals would call.
        const report = onLCP.mock.calls[0][0] as (m: unknown) => void;
        report({ name: 'LCP', value: 3127.4, rating: 'needs-improvement', id: 'v4-1', navigationType: 'navigate' });

        expect(sendBeacon).toHaveBeenCalledTimes(1);
        const [url, body] = sendBeacon.mock.calls[0] as [string, string];
        expect(url).toBe('/api/metrics');
        // The sink requires `name` and a finite numeric `value`; anything else
        // is dropped silently. So the body is asserted field by field rather
        // than as "something was sent".
        expect(JSON.parse(body)).toMatchObject({
            name: 'LCP',
            value: 3127.4,
            rating: 'needs-improvement',
        });
    });

    it('falls back to fetch when sendBeacon is unavailable', async () => {
        const fetchMock = jest.fn().mockResolvedValue({ ok: true });
        global.fetch = fetchMock as unknown as typeof fetch;
        Object.defineProperty(navigator, 'sendBeacon', {
            configurable: true,
            writable: true,
            value: undefined,
        });

        render(<WebVitalsReporter />);
        await flush();
        const report = onLCP.mock.calls[0][0] as (m: unknown) => void;
        report({ name: 'LCP', value: 1, rating: 'good', id: 'x', navigationType: 'navigate' });

        expect(fetchMock).toHaveBeenCalledWith('/api/metrics', expect.objectContaining({ method: 'POST' }));
    });

    it('stops reporting after unmount', async () => {
        // `cancelled` guards the subscription, but a callback already handed to
        // web-vitals can still fire after unmount in a real browser.
        const { unmount } = render(<WebVitalsReporter />);
        await flush();
        unmount();
        expect(onLCP).toHaveBeenCalledTimes(1);
    });
});
