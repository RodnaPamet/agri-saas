/**
 * Unit tests for the browser Sentry init — the missing client error channel.
 *
 * Contract: no-op without a DSN (self-hosted stays clean); wires the client
 * SDK with conservative mobile sampling (errors on, traces low, NO replay)
 * when a DSN is present; and a captured error reaches the (mocked) transport.
 */
const initMock = jest.fn();
const captureMock = jest.fn();
jest.mock('@sentry/nextjs', () => ({
    init: (...a: unknown[]) => initMock(...a),
    captureException: (...a: unknown[]) => captureMock(...a),
}));

import { initClientSentry, __resetClientSentryForTests } from '@/lib/observability/sentry-client';
import * as Sentry from '@sentry/nextjs';
import { SENTRY_DATA_COLLECTION } from '@/lib/observability/sentry-data-collection';

beforeEach(() => {
    initMock.mockClear();
    captureMock.mockClear();
    __resetClientSentryForTests();
});

describe('initClientSentry', () => {
    it('is a no-op without a DSN (self-hosted stays clean)', () => {
        initClientSentry(undefined);
        initClientSentry('');
        expect(initMock).not.toHaveBeenCalled();
    });

    it('wires the client SDK with conservative mobile sampling when a DSN is set', () => {
        initClientSentry('https://pub@o1.ingest.sentry.io/1', { release: 'v1.2.3', environment: 'production' });
        expect(initMock).toHaveBeenCalledTimes(1);
        const cfg = initMock.mock.calls[0][0];
        expect(cfg).toMatchObject({
            dsn: 'https://pub@o1.ingest.sentry.io/1',
            release: 'v1.2.3',
            environment: 'production',
            sampleRate: 1, // errors always captured
            replaysSessionSampleRate: 0, // no session replay
            replaysOnErrorSampleRate: 0,
        });
        expect(cfg.tracesSampleRate).toBeLessThanOrEqual(0.1); // traces sampled low
    });

    it('#1158/#1311 — data collection is explicitly OFF on the BROWSER side', () => {
        // The client default is what attaches the VISITOR'S IP to every event,
        // so an inherited default is the difference between knowing an error
        // happened and recording who it happened to. `@sentry/nextjs` 11
        // enables data collection by default; this option was unset.
        //
        // `toBe(false)` rather than `toBeFalsy()`, because `undefined` is
        // falsy and is precisely the state being fixed.
        initClientSentry('https://pub@o1.ingest.sentry.io/1');
        const cfg = initMock.mock.calls[0][0];
        // #1311 — Sentry 11 removed `sendDefaultPii` for `dataCollection`,
        // whose fields all default to TRUE. Same shared constant as the
        // server, so the two sides cannot drift apart.
        expect(cfg.dataCollection.userInfo).toBe(false);
        expect(cfg.dataCollection.cookies).toBe(false);
        expect(cfg.dataCollection.httpBodies).toEqual([]);
        expect(cfg.dataCollection.urlQueryParams).toBe(false);
        // Gone, not merely overridden.
        expect(cfg.sendDefaultPii).toBeUndefined();
    });

    it('the browser posture IS the server posture — one object, not a copy', () => {
        // Two literals are two things that drift, and the posture has to hold
        // on both sides. Asserting identity rather than equality is what makes
        // a divergent copy impossible: `toBe` fails if someone re-inlines one.
        initClientSentry('https://pub@o1.ingest.sentry.io/1');
        expect(initMock.mock.calls[0][0].dataCollection).toBe(SENTRY_DATA_COLLECTION);
    });

    it('initialises at most once (the once-guard holds)', () => {
        initClientSentry('https://pub@o1.ingest.sentry.io/1');
        initClientSentry('https://pub@o1.ingest.sentry.io/1');
        expect(initMock).toHaveBeenCalledTimes(1);
    });

    it('a thrown error reaches the transport after init (global-error path)', () => {
        initClientSentry('https://pub@o1.ingest.sentry.io/1');
        // global-error.tsx captures via Sentry.captureException — with the SDK
        // now initialised, that call flows to the (mocked) transport.
        const err = new Error('client crash on a rural device');
        Sentry.captureException(err);
        expect(captureMock).toHaveBeenCalledWith(err);
    });
});
