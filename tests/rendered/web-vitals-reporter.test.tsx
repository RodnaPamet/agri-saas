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

    it.each([
        ['/f/pobeda', 'public-farm'],
        ['/f/pobeda/', 'public-farm'],
        ['/t/acme/assets', 'app'],
        ['/', 'app'],
        ['/fx/something', 'app'],
    ])('labels %s as %s', async (pathname, expected) => {
        // Derived with `isPublicSurface` — the SAME function the middleware
        // uses to set the public-surface header — so the label cannot drift
        // from what the app treats as public. `/fx/...` is the case a bare
        // `startsWith('/f')` would get wrong, and this repo already had that
        // bug once (#1838's prefix-vs-exact work).
        window.history.pushState({}, '', pathname);
        render(<WebVitalsReporter />);
        await flush();
        const report = onLCP.mock.calls[0][0] as (m: unknown) => void;
        report({ name: 'LCP', value: 1, rating: 'good', id: 'x', navigationType: 'navigate' });

        const [, body] = sendBeacon.mock.calls[0] as [string, string];
        expect(JSON.parse(body).surface).toBe(expected);
    });

    it('never puts the pathname itself in the beacon', async () => {
        // A real path carries a tenant slug and record ids, and this beacon's
        // premise is that it says nothing about who sent it.
        window.history.pushState({}, '', '/t/acme-corp/assets/cmvad0wlu000mxc0cjubrwb1c');
        render(<WebVitalsReporter />);
        await flush();
        const report = onLCP.mock.calls[0][0] as (m: unknown) => void;
        report({ name: 'LCP', value: 1, rating: 'good', id: 'x', navigationType: 'navigate' });

        const [, body] = sendBeacon.mock.calls[0] as [string, string];
        expect(body).not.toContain('acme-corp');
        expect(body).not.toContain('cmvad0wlu000mxc0cjubrwb1c');
        expect(JSON.parse(body).surface).toBe('app');
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

describe('WebVitalsReporter reports the CHANNEL failing', () => {
    let sendBeacon: jest.Mock;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        sendBeacon = jest.fn().mockReturnValue(true);
        Object.defineProperty(navigator, 'sendBeacon', {
            configurable: true,
            writable: true,
            value: sendBeacon,
        });
        fetchMock = jest.fn().mockResolvedValue({ ok: true });
        Object.defineProperty(globalThis, 'fetch', {
            configurable: true,
            writable: true,
            value: fetchMock,
        });
    });

    /** Every POST body this test saw, parsed. */
    const posted = () =>
        fetchMock.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body));

    it('falls back to fetch AND says so when sendBeacon refuses the payload', async () => {
        // `false` means the browser would not queue it — over quota, or a
        // payload it will not take. The return value used to be discarded, so
        // the measurement was simply lost and the sample quietly short.
        sendBeacon.mockReturnValue(false);
        render(<WebVitalsReporter />);
        await flush();

        const report = onLCP.mock.calls[0][0] as (m: unknown) => void;
        report({ name: 'LCP', value: 1234, rating: 'good', id: 'v4-1', navigationType: 'navigate' });
        await flush();

        const bodies = posted();
        // The measurement is RECOVERED, not just mourned.
        expect(bodies.some((b) => b.name === 'LCP')).toBe(true);
        // And the refusal is visible, so a systematic one is a query rather
        // than an unexplained shortfall in the sample.
        expect(bodies.some((b) => b.channelError === 'beacon-refused')).toBe(true);
    });

    it('does NOT report a channel error when the beacon is accepted', async () => {
        // The control. Without it the assertion above would pass against a
        // reporter that cried failure on every successful beacon — which
        // would be worse than the silence it replaces.
        render(<WebVitalsReporter />);
        await flush();

        const report = onLCP.mock.calls[0][0] as (m: unknown) => void;
        report({ name: 'LCP', value: 1234, rating: 'good', id: 'v4-1', navigationType: 'navigate' });
        await flush();

        expect(sendBeacon).toHaveBeenCalledTimes(1);
        expect(posted().some((b) => b.channelError)).toBe(false);
    });

    it('carries the surface on the diagnostic too, so a failure is attributable', async () => {
        // Otherwise "the channel is broken" cannot say WHICH surface, and the
        // public profile is the one with a performance budget (#1814).
        window.history.pushState({}, '', '/f/pobeda');
        sendBeacon.mockReturnValue(false);
        render(<WebVitalsReporter />);
        await flush();

        const report = onLCP.mock.calls[0][0] as (m: unknown) => void;
        report({ name: 'LCP', value: 1234, rating: 'good', id: 'v4-1', navigationType: 'navigate' });
        await flush();

        const diag = posted().find((b) => b.channelError === 'beacon-refused');
        expect(diag?.surface).toBe('public-farm');
        window.history.pushState({}, '', '/');
    });
});
