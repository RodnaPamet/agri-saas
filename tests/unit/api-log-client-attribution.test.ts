/**
 * Every request log line must carry WHICH CLIENT made the request.
 *
 * ── why this exists ──
 *
 * The app logs a structured line per request (`request started`,
 * `request completed`, `request rate-limited`, `request failed`) carrying
 * `route`, `method`, `status`, `durationMs` and `requestId`. It did NOT carry
 * the client, and `x-agrent-client` was already being read two lines above the
 * first of those calls — it went to metrics and the usage counter only.
 *
 * That gap is not cosmetic. The usage counter's fields are DAILY counts over
 * `client|device|METHOD surface`, so it can say "an iOS client hit the auth
 * surface today" and nothing finer — no time, and no way to tell which of a
 * burst of concurrent requests came from the phone. The log line is the only
 * per-request record with a timestamp, so without the client on it there is no
 * way to attribute a single request to a platform at all. Asked for by the iOS
 * session, which needed exactly this to tell its own /me calls apart from a
 * browser's while measuring flag propagation.
 *
 * ── why logging this field is safe, and the raw header would not be ──
 *
 * `usageClient` is `normaliseClient(header)`, which collapses anything
 * caller-controlled onto a fixed allowlist plus `other`/`unknown`. The last
 * test below is the one that matters: a hostile 5KB header must appear in the
 * log as `other`. Logging `req.headers.get('x-agrent-client')` directly would
 * put unbounded attacker-controlled text on every line of the log stream.
 */
import { NextRequest } from 'next/server';
import type { RateLimitConfig } from '@/lib/security/rate-limit';

const logInfo = jest.fn();
const logWarn = jest.fn();
const logError = jest.fn();

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        info: (...a: unknown[]) => logInfo(...a),
        warn: (...a: unknown[]) => logWarn(...a),
        error: (...a: unknown[]) => logError(...a),
        debug: jest.fn(),
    },
    extractErrorMeta: (e: unknown) => ({ message: String(e) }),
}));

// Metrics and Sentry are side-channels this file makes no claim about; stubbing
// them keeps the subject the LOG LINE. The usage counter is deliberately NOT
// stubbed — `normaliseClient` is the real normaliser, and it is the thing the
// safety property below turns on.
jest.mock('@/lib/observability/metrics', () => ({
    recordRequestMetrics: jest.fn(),
    recordRequestError: jest.fn(),
}));
jest.mock('@/lib/observability/sentry', () => ({ captureError: jest.fn() }));

/**
 * The 429 line is a FOURTH call site, and the only one that fires while a
 * client is being refused — which is exactly when you most want to know which
 * client it was. Reaching it needs two things: a mutation method (the scope
 * resolver returns null for GET) and a limiter that actually blocks.
 */
const enforceMock = jest.fn();
jest.mock('@/lib/security/rate-limit-middleware', () => ({
    enforceRateLimit: (...a: unknown[]) => enforceMock(...a),
    isRateLimitBypassed: () => false,
    API_MUTATION_LIMIT: { maxAttempts: 10, windowMs: 60_000 } satisfies RateLimitConfig,
}));

import { withApiErrorHandling } from '@/lib/errors/api';

function req(
    client: string | null,
    path = '/api/auth/me',
    method = 'GET',
): NextRequest {
    const headers = new Headers();
    if (client !== null) headers.set('x-agrent-client', client);
    const url = new URL(`http://localhost:3000${path}`);
    return {
        method,
        headers,
        nextUrl: url,
        url: url.toString(),
        json: async () => ({}),
        text: async () => '',
    } as unknown as NextRequest;
}

/** Every `meta` object the logger was handed, across all three levels. */
function loggedMetas(): Array<Record<string, unknown>> {
    return [...logInfo.mock.calls, ...logWarn.mock.calls, ...logError.mock.calls]
        .map((c) => c[1])
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object');
}

beforeEach(() => jest.clearAllMocks());

describe('the client reaches the log line', () => {
    it('a successful request logs the client on EVERY line it emits', async () => {
        const handler = withApiErrorHandling(async () => new Response('ok', { status: 200 }));
        await handler(req('ios/1.0'), undefined);

        const metas = loggedMetas();
        // The denominator, printed as an assertion rather than assumed: a
        // success emits `request started` AND `request completed`. If a future
        // change drops one, this count moves and the loop below silently
        // covers less.
        expect(metas).toHaveLength(2);
        for (const m of metas) expect(m.client).toBe('ios/1.0');
    });

    it('a THROWING request logs the client on the failure line', async () => {
        const handler = withApiErrorHandling(async () => {
            throw new Error('boom');
        });
        await handler(req('ios/1.0'), undefined);

        expect(logError).toHaveBeenCalled();
        const failure = logError.mock.calls[0][1] as Record<string, unknown>;
        expect(failure.client).toBe('ios/1.0');
        // The error path is a SEPARATE call site from the success path, which is
        // why it gets its own case: adding the field to one and not the other
        // leaves exactly the requests you most want to attribute unattributed.
        expect(failure.status).toBe(500);
    });

    it('an absent header logs `unknown` rather than omitting the field', async () => {
        const handler = withApiErrorHandling(async () => new Response('ok', { status: 200 }));
        await handler(req(null), undefined);
        // Omission and `unknown` read identically in a log search for
        // `client=ios/1.0`, but differ when asking "how many requests carried no
        // client at all" — a question with an answer only if the field is there.
        for (const m of loggedMetas()) expect(m.client).toBe('unknown');
    });

    it('a HOSTILE header cannot put unbounded text on a log line', async () => {
        const handler = withApiErrorHandling(async () => new Response('ok', { status: 200 }));
        const hostile = 'ios/' + '9'.repeat(5000);
        await handler(req(hostile), undefined);

        const metas = loggedMetas();
        expect(metas.length).toBeGreaterThan(0);
        for (const m of metas) {
            expect(m.client).toBe('other');
            // The actual property: nothing the caller sent survives onto the
            // line. Asserting `'other'` alone would still pass if some other
            // field carried the raw header through.
            expect(JSON.stringify(m)).not.toContain('99999');
        }
    });

    it('a cardinality attack cannot mint one client value per request', async () => {
        const handler = withApiErrorHandling(async () => new Response('ok', { status: 200 }));
        const seen = new Set<unknown>();
        for (let i = 0; i < 25; i++) {
            jest.clearAllMocks();
            await handler(req(`attacker/${i}.${i}`), undefined);
            for (const m of loggedMetas()) seen.add(m.client);
        }
        // 25 distinct headers collapse to ONE logged value. A log field is a
        // cardinality surface too, not just a metrics label.
        expect(seen).toEqual(new Set(['other']));
    });
});

describe('the RATE-LIMITED line carries it too', () => {
    it('a 429 logs the client that was refused', async () => {
        const { NextResponse } = await import('next/server');
        enforceMock.mockResolvedValue({
            response: NextResponse.json({ error: 'too_many_requests' }, { status: 429 }),
        });

        const handler = withApiErrorHandling(
            async () => new Response('unreached', { status: 200 }),
            {
                rateLimit: {
                    config: { maxAttempts: 1, windowMs: 60_000 } satisfies RateLimitConfig,
                    scope: 'test-scope',
                },
            },
        );
        const res = await handler(req('ios/1.0', '/api/t/acme/journal', 'POST'), undefined);
        expect(res.status).toBe(429);

        // Positive control FIRST: without it, a limiter that never blocked
        // would leave `logWarn` empty and the loop below would pass vacuously
        // on an empty selection.
        expect(logWarn).toHaveBeenCalledTimes(1);
        const refusal = logWarn.mock.calls[0][1] as Record<string, unknown>;
        expect(refusal.client).toBe('ios/1.0');
        expect(refusal.scope).toBe('test-scope');
    });

    it('a GET never reaches the limiter, so the other cases are unaffected', async () => {
        // Guards the harness itself: the module-level mock above would silently
        // change every case in this file if GETs took the rate-limit path.
        const handler = withApiErrorHandling(async () => new Response('ok', { status: 200 }));
        await handler(req('web/3.70'), undefined);
        expect(enforceMock).not.toHaveBeenCalled();
        expect(logWarn).not.toHaveBeenCalled();
    });
});
