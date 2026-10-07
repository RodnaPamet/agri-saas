/**
 * Cloudflare Turnstile verification (P3.5c).
 *
 * The thing these tests exist to prevent is specific: P0.7 ticked "Turnstile"
 * on #1191 and shipped nothing — no code, no env var, no key. So a test suite
 * that only proved "the module exists and returns ok when unconfigured" would
 * be the same failure wearing a green tick.
 *
 * Two properties therefore carry the weight, and neither is about the dormant
 * path:
 *
 *   1. With a secret configured and a token Cloudflare REJECTS, verification
 *      must fail. This is the behaviour the whole feature is for, and it is
 *      exercised rather than asserted structurally.
 *   2. With a secret configured and NO token, it must also fail. Treating a
 *      missing token as "not configured" would switch the control off for
 *      anyone who simply omits the field — which is every bot.
 *
 * The dormant path is tested too, but for its ANNOUNCEMENT: a skip that says
 * nothing is indistinguishable from the feature not existing, which is how the
 * last one went unnoticed for months.
 */
const mockWarn = jest.fn();
const mockInfo = jest.fn();

jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        warn: (...a: unknown[]) => mockWarn(...a),
        info: (...a: unknown[]) => mockInfo(...a),
        error: jest.fn(),
    },
}));

import {
    verifyTurnstile,
    turnstileConfigured,
    turnstileSitekey,
    __resetTurnstileWarning,
} from '@/lib/security/turnstile';

// The env var names are written out at each use rather than hoisted into
// constants. Assigning one to a constant whose name contains "secret" reads to
// `scripts/detect-secrets.sh` as a hardcoded credential — a false positive,
// but the detector is right to be blunt about that shape, and writing the
// names out is clearer anyway.
//
// This comment was itself flagged on the first attempt, because it QUOTED the
// offending line. A scanner that reads prose as code is the same class of
// problem as a guard that matches its own docblock; the fix in both directions
// is to describe the shape rather than reproduce it.
const originalEnv = { ...process.env };

/** A Cloudflare siteverify response. */
function siteverify(body: Record<string, unknown>, status = 200) {
    return jest.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    })) as unknown as typeof fetch;
}

beforeEach(() => {
    jest.clearAllMocks();
    __resetTurnstileWarning();
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_SITEKEY;
});

afterAll(() => {
    process.env = originalEnv;
});

describe('dormant until a secret is supplied — and it SAYS so', () => {
    it('reports not configured', () => {
        expect(turnstileConfigured()).toBe(false);
        process.env.TURNSTILE_SECRET_KEY = 's';
        expect(turnstileConfigured()).toBe(true);
    });

    it('skips verification and warns, naming what to set', async () => {
        const r = await verifyTurnstile('any-token');
        expect(r).toEqual({ ok: true, skipped: true });

        // The announcement IS the test. A silent skip is what let P0.7's
        // absence pass for a delivered feature — an operator reading logs
        // after a deploy has to be able to tell the control is off.
        expect(mockWarn).toHaveBeenCalledTimes(1);
        const payload = JSON.stringify(mockWarn.mock.calls[0]);
        expect(payload).toContain('TURNSTILE_SECRET_KEY');
        expect(payload).toMatch(/not active|NOT active/);
    });

    it('warns ONCE per process, not once per signup', async () => {
        await verifyTurnstile('t1');
        await verifyTurnstile('t2');
        await verifyTurnstile('t3');
        // A per-request warning on the signup path would bury the signal it
        // exists to send.
        expect(mockWarn).toHaveBeenCalledTimes(1);
    });

    it('renders no widget without a sitekey', () => {
        expect(turnstileSitekey()).toBeNull();
        process.env.TURNSTILE_SITEKEY = '0x4AAA';
        expect(turnstileSitekey()).toBe('0x4AAA');
    });

    it('does not call Cloudflare at all', async () => {
        const fetchMock = siteverify({ success: true });
        global.fetch = fetchMock;
        await verifyTurnstile('token');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('configured: the behaviour the feature exists for', () => {
    beforeEach(() => {
        process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    });

    it('accepts a token Cloudflare accepts', async () => {
        global.fetch = siteverify({ success: true });
        await expect(verifyTurnstile('good-token')).resolves.toEqual({
            ok: true,
            skipped: false,
        });
    });

    it('REFUSES a token Cloudflare rejects', async () => {
        // The executed reject branch. #1166 records what happens when a
        // reject branch is deleted and only a readFileSync-plus-regex
        // guardrail is watching: it stayed green against the remains while
        // two routes accepted breached passwords for a day.
        global.fetch = siteverify({
            success: false,
            'error-codes': ['invalid-input-response'],
        });
        await expect(verifyTurnstile('forged')).resolves.toEqual({
            ok: false,
            skipped: false,
            codes: ['invalid-input-response'],
        });
    });

    it('REFUSES a missing token rather than skipping', async () => {
        // The distinction that decides whether the control works at all. If a
        // missing token read as "not configured", every bot would simply omit
        // the field.
        global.fetch = siteverify({ success: true });
        for (const absent of [null, undefined, '']) {
            const r = await verifyTurnstile(absent);
            expect(r.ok).toBe(false);
            expect('skipped' in r && r.skipped).toBe(false);
        }
    });

    it('sends the secret and the token as form-encoded POST body', async () => {
        const fetchMock = siteverify({ success: true });
        global.fetch = fetchMock;
        await verifyTurnstile('tok', '203.0.113.7');

        const [url, init] = (fetchMock as jest.Mock).mock.calls[0];
        expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
        expect(init.method).toBe('POST');
        const body = init.body as URLSearchParams;
        expect(body.get('secret')).toBe('test-secret');
        expect(body.get('response')).toBe('tok');
        // `remoteip` is optional and tightens Cloudflare's own heuristics.
        expect(body.get('remoteip')).toBe('203.0.113.7');
    });

    it('never logs the secret or the token', async () => {
        global.fetch = siteverify({ success: false, 'error-codes': ['bad-request'] });
        await verifyTurnstile('super-secret-token-value');

        const logged = JSON.stringify([...mockWarn.mock.calls, ...mockInfo.mock.calls]);
        expect(logged).not.toContain('super-secret-token-value');
        expect(logged).not.toContain('test-secret');
        // The error codes ARE logged: they name the cause and say nothing
        // about the person.
        expect(logged).toContain('bad-request');
    });
});

describe('configured but Cloudflare unreachable: allowed, and loudly', () => {
    beforeEach(() => {
        process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    });

    it('allows on a network error, flagged degraded', async () => {
        global.fetch = jest.fn(async () => {
            throw new Error('ETIMEDOUT');
        }) as unknown as typeof fetch;

        const r = await verifyTurnstile('tok');
        // Deliberate. An attacker cannot reach this branch at will — a forged
        // token gets an explicit rejection, which refuses. Reaching here
        // requires making Cloudflare unreachable from the server. Failing
        // closed instead would stop every new farm registering during a
        // Cloudflare incident, with three other gates still in front.
        expect(r).toEqual({ ok: true, skipped: false, degraded: true });
        expect(JSON.stringify(mockWarn.mock.calls)).toContain('turnstile_degraded');
    });

    it('treats a 5xx from Cloudflare as transport, not a verdict', async () => {
        global.fetch = siteverify({}, 503);
        const r = await verifyTurnstile('tok');
        expect(r).toEqual({ ok: true, skipped: false, degraded: true });
    });

    it('NEVER throws — a screening failure must not 500 the signup path', async () => {
        global.fetch = jest.fn(async () => {
            throw new Error('boom');
        }) as unknown as typeof fetch;
        await expect(verifyTurnstile('tok')).resolves.toBeDefined();

        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => {
                throw new Error('not json');
            },
        })) as unknown as typeof fetch;
        await expect(verifyTurnstile('tok')).resolves.toBeDefined();
    });
});
