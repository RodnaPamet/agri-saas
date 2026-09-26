/**
 * Unit Test: Epic A.2 rate-limit middleware.
 *
 * Pins the middleware's contract surface:
 *   - IP extraction fallback chain
 *   - keying (auth vs anon; separate budgets per (IP, userId))
 *   - 429 response shape: status, Retry-After header, safe JSON body
 *   - X-RateLimit-* informational headers
 *   - withRateLimit wrapper short-circuits blocked requests before
 *     the handler runs; passes through successful ones
 *   - preset sanity: each preset is a realistic policy, not a typo
 */

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
    },
}));

import {
    getClientIp,
    buildRateLimitKey,
    enforceRateLimit,
    withRateLimit,
    LOGIN_LIMIT,
    API_MUTATION_LIMIT,
    API_KEY_CREATE_LIMIT,
    EMAIL_DISPATCH_LIMIT,
    EXCHANGE_INQUIRY_LIMIT,
    INSURANCE_LEAD_LIMIT,
    clearAllRateLimits,
} from '@/lib/security/rate-limit-middleware';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Build a minimal NextRequest-compatible object for tests. We use a
 * real URL + Headers so the middleware's type checks hold without
 * a running Next server.
 */
function fakeReq(options: {
    url?: string;
    forwardedFor?: string;
    realIp?: string;
    ip?: string;
} = {}): NextRequest {
    const headers = new Headers();
    if (options.forwardedFor) headers.set('x-forwarded-for', options.forwardedFor);
    if (options.realIp) headers.set('x-real-ip', options.realIp);
    const req = new NextRequest(options.url ?? 'http://localhost/api/x', {
        method: 'POST',
        headers,
    });
    if (options.ip) {
        // NextRequest.ip is readonly; test-only override.
        Object.defineProperty(req, 'ip', { value: options.ip, configurable: true });
    }
    return req;
}

describe('getClientIp', () => {
    it('prefers x-forwarded-for first value', () => {
        const req = fakeReq({ forwardedFor: '1.2.3.4, 5.6.7.8' });
        expect(getClientIp(req)).toBe('1.2.3.4');
    });

    it('falls through to x-real-ip when x-forwarded-for is absent', () => {
        const req = fakeReq({ realIp: '9.9.9.9' });
        expect(getClientIp(req)).toBe('9.9.9.9');
    });

    it('falls through to req.ip when headers are absent', () => {
        const req = fakeReq({ ip: '10.0.0.1' });
        expect(getClientIp(req)).toBe('10.0.0.1');
    });

    it("returns 'unknown' when every source is missing", () => {
        const req = fakeReq();
        expect(getClientIp(req)).toBe('unknown');
    });

    it('trims whitespace around forwarded values', () => {
        const req = fakeReq({ forwardedFor: '   1.2.3.4   ,5.6.7.8' });
        expect(getClientIp(req)).toBe('1.2.3.4');
    });
});

describe('buildRateLimitKey', () => {
    it('includes scope, ip, and userId for authenticated callers', () => {
        expect(buildRateLimitKey('login', '1.2.3.4', 'user-1')).toBe(
            'login:ip:1.2.3.4:u:user-1'
        );
    });

    it('uses anon bucket when userId is null or undefined', () => {
        expect(buildRateLimitKey('login', '1.2.3.4', null)).toBe(
            'login:ip:1.2.3.4:anon'
        );
        expect(buildRateLimitKey('login', '1.2.3.4')).toBe(
            'login:ip:1.2.3.4:anon'
        );
    });

    it('keeps scopes isolated from each other', () => {
        const a = buildRateLimitKey('login', '1.2.3.4', 'user-1');
        const b = buildRateLimitKey('api-mutation', '1.2.3.4', 'user-1');
        expect(a).not.toBe(b);
    });
});

describe('enforceRateLimit', () => {
    beforeEach(() => {
        clearAllRateLimits();
        jest.clearAllMocks();
    });

    it('allows requests under the budget and reports remaining', async () => {
        const req = fakeReq({ forwardedFor: '1.1.1.1' });
        const first = await enforceRateLimit(req, {
            scope: 'test-scope',
            config: { maxAttempts: 3, windowMs: 60_000 },
            userId: 'u1',
        });
        expect(first.response).toBeUndefined();
        expect(first.result.allowed).toBe(true);
        expect(first.result.remaining).toBe(2);

        const second = await enforceRateLimit(req, {
            scope: 'test-scope',
            config: { maxAttempts: 3, windowMs: 60_000 },
            userId: 'u1',
        });
        expect(second.result.remaining).toBe(1);
    });

    it('returns a 429 response once the budget is exhausted', async () => {
        const req = fakeReq({ forwardedFor: '2.2.2.2' });
        const config = { maxAttempts: 2, windowMs: 60_000 };
        await enforceRateLimit(req, { scope: 'burst', config, userId: 'u2' });
        await enforceRateLimit(req, { scope: 'burst', config, userId: 'u2' });
        const blocked = await enforceRateLimit(req, {
            scope: 'burst',
            config,
            userId: 'u2',
        });

        expect(blocked.response).toBeDefined();
        expect(blocked.response?.status).toBe(429);
        expect(blocked.result.allowed).toBe(false);

        const body = await blocked.response!.json();
        expect(body.error.code).toBe('RATE_LIMITED');
        expect(body.error.scope).toBe('burst');
        expect(typeof body.error.retryAfterSeconds).toBe('number');
        expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('sets Retry-After and X-RateLimit-* headers on 429', async () => {
        const req = fakeReq({ forwardedFor: '3.3.3.3' });
        const config = { maxAttempts: 1, windowMs: 60_000 };
        await enforceRateLimit(req, { scope: 'hdr', config });
        const blocked = await enforceRateLimit(req, { scope: 'hdr', config });

        expect(blocked.response).toBeDefined();
        const h = blocked.response!.headers;
        expect(h.get('Retry-After')).toMatch(/^\d+$/);
        expect(Number(h.get('Retry-After'))).toBeGreaterThan(0);
        expect(h.get('X-RateLimit-Limit')).toBe('1');
        expect(h.get('X-RateLimit-Remaining')).toBe('0');
        expect(h.get('X-RateLimit-Reset')).toMatch(/^\d+$/);
    });

    it('429 body never leaks the key, IP, or userId', async () => {
        const req = fakeReq({ forwardedFor: '4.4.4.4' });
        const config = { maxAttempts: 1, windowMs: 60_000 };
        await enforceRateLimit(req, { scope: 's', config, userId: 'user-secret' });
        const blocked = await enforceRateLimit(req, {
            scope: 's',
            config,
            userId: 'user-secret',
        });
        const body = JSON.stringify(await blocked.response!.json());
        expect(body).not.toContain('user-secret');
        expect(body).not.toContain('4.4.4.4');
        expect(body).not.toContain('ip:');
    });

    it('retryAfterSeconds is never less than 1 (never silently 0)', async () => {
        const req = fakeReq({ forwardedFor: '5.5.5.5' });
        // Sub-second remaining budget: retryAfterMs ≈ 900ms → ceil = 1s, so the
        // Math.max(1, …) clamp is exercised. The window must stay wide enough
        // that the SECOND (now-async) call still lands inside it — a 10ms window
        // was racy against async scheduling jitter.
        const config = { maxAttempts: 1, windowMs: 900 };
        await enforceRateLimit(req, { scope: 's', config });
        const blocked = await enforceRateLimit(req, { scope: 's', config });
        const body = await blocked.response!.json();
        expect(body.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });
});

describe('keying isolation', () => {
    beforeEach(() => {
        clearAllRateLimits();
    });

    it('different users on same IP have independent budgets', async () => {
        const req = fakeReq({ forwardedFor: '10.0.0.1' });
        const config = { maxAttempts: 1, windowMs: 60_000 };

        const a = await enforceRateLimit(req, {
            scope: 'iso',
            config,
            userId: 'alice',
        });
        const b = await enforceRateLimit(req, {
            scope: 'iso',
            config,
            userId: 'bob',
        });

        expect(a.response).toBeUndefined();
        expect(b.response).toBeUndefined();
    });

    it('same user on different IPs have independent budgets', async () => {
        const config = { maxAttempts: 1, windowMs: 60_000 };

        const fromOffice = await enforceRateLimit(
            fakeReq({ forwardedFor: '10.0.0.1' }),
            { scope: 'iso2', config, userId: 'alice' }
        );
        const fromHome = await enforceRateLimit(
            fakeReq({ forwardedFor: '192.168.1.1' }),
            { scope: 'iso2', config, userId: 'alice' }
        );

        expect(fromOffice.response).toBeUndefined();
        expect(fromHome.response).toBeUndefined();
    });

    it('unauthenticated traffic from same IP shares a bucket', async () => {
        const config = { maxAttempts: 1, windowMs: 60_000 };

        const first = await enforceRateLimit(
            fakeReq({ forwardedFor: '10.10.10.10' }),
            { scope: 'anon-scope', config }
        );
        const second = await enforceRateLimit(
            fakeReq({ forwardedFor: '10.10.10.10' }),
            { scope: 'anon-scope', config }
        );

        expect(first.response).toBeUndefined();
        expect(second.response).toBeDefined();
        expect(second.response?.status).toBe(429);
    });

    it('unauthenticated and authenticated from same IP have separate budgets', async () => {
        const config = { maxAttempts: 1, windowMs: 60_000 };
        const req = fakeReq({ forwardedFor: '20.20.20.20' });

        const anon = await enforceRateLimit(req, {
            scope: 'mixed',
            config,
        });
        const auth = await enforceRateLimit(req, {
            scope: 'mixed',
            config,
            userId: 'signed-in',
        });

        expect(anon.response).toBeUndefined();
        expect(auth.response).toBeUndefined();
    });
});

describe('withRateLimit wrapper', () => {
    beforeEach(() => {
        clearAllRateLimits();
    });

    it('invokes the handler when under the budget', async () => {
        const handler = jest.fn(async () =>
            NextResponse.json({ ok: true })
        );
        const wrapped = withRateLimit(handler, {
            scope: 'w1',
            config: { maxAttempts: 3, windowMs: 60_000 },
        });

        const res = await wrapped(fakeReq({ forwardedFor: '1.1.1.1' }));
        expect(handler).toHaveBeenCalledTimes(1);
        expect(res.status).toBe(200);
    });

    it('short-circuits to 429 without calling the handler when blocked', async () => {
        const handler = jest.fn(async () =>
            NextResponse.json({ ok: true })
        );
        const wrapped = withRateLimit(handler, {
            scope: 'w2',
            config: { maxAttempts: 1, windowMs: 60_000 },
        });

        const req = fakeReq({ forwardedFor: '1.2.3.4' });
        await wrapped(req);
        const blocked = await wrapped(req);

        expect(handler).toHaveBeenCalledTimes(1); // second call blocked
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('Retry-After')).toMatch(/^\d+$/);
    });

    it('resolves userId via getUserId for keying', async () => {
        const handler = jest.fn(async () =>
            NextResponse.json({ ok: true })
        );
        const getUserId = jest.fn(async () => 'resolved-user');
        const wrapped = withRateLimit(handler, {
            scope: 'w3',
            config: { maxAttempts: 100, windowMs: 60_000 },
            getUserId,
        });

        await wrapped(fakeReq({ forwardedFor: '1.1.1.1' }));
        expect(getUserId).toHaveBeenCalled();
        expect(handler).toHaveBeenCalled();
    });

    it('treats a getUserId throw as anonymous (falls back cleanly)', async () => {
        const handler = jest.fn(async () =>
            NextResponse.json({ ok: true })
        );
        const wrapped = withRateLimit(handler, {
            scope: 'w4',
            config: { maxAttempts: 1, windowMs: 60_000 },
            getUserId: async () => {
                throw new Error('no session yet');
            },
        });

        const res = await wrapped(fakeReq({ forwardedFor: '1.1.1.1' }));
        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalled();
    });

    it('forwards additional route params to the handler', async () => {
        const handler = jest.fn(async (_req, params) =>
            NextResponse.json({ params })
        );
        const wrapped = withRateLimit(handler, {
            scope: 'w5',
            config: { maxAttempts: 3, windowMs: 60_000 },
        });

        await wrapped(fakeReq({ forwardedFor: '1.1.1.1' }), { tenantSlug: 'acme' });
        expect(handler.mock.calls[0][1]).toEqual({ tenantSlug: 'acme' });
    });
});

describe('Preset policy sanity', () => {
    // Guardrails on the presets themselves — catches a typo that
    // accidentally makes a preset too permissive or disables a lockout.
    const CASES: Array<[string, typeof LOGIN_LIMIT]> = [
        ['LOGIN_LIMIT', LOGIN_LIMIT],
        ['API_MUTATION_LIMIT', API_MUTATION_LIMIT],
        ['API_KEY_CREATE_LIMIT', API_KEY_CREATE_LIMIT],
        ['EMAIL_DISPATCH_LIMIT', EMAIL_DISPATCH_LIMIT],
        ['INSURANCE_LEAD_LIMIT', INSURANCE_LEAD_LIMIT],
    ];

    it.each(CASES)('%s has a positive maxAttempts', (_, preset) => {
        expect(preset.maxAttempts).toBeGreaterThan(0);
    });

    it.each(CASES)('%s has a positive windowMs', (_, preset) => {
        expect(preset.windowMs).toBeGreaterThan(0);
    });

    it('LOGIN_LIMIT + API_KEY_CREATE_LIMIT have a lockout', () => {
        expect(LOGIN_LIMIT.lockoutMs).toBeGreaterThan(0);
        expect(API_KEY_CREATE_LIMIT.lockoutMs).toBeGreaterThan(0);
    });

    it('API_MUTATION_LIMIT budget ≥ LOGIN_LIMIT budget (mutation is a high-traffic surface)', () => {
        expect(API_MUTATION_LIMIT.maxAttempts).toBeGreaterThanOrEqual(
            LOGIN_LIMIT.maxAttempts
        );
    });

    it('INSURANCE_LEAD_LIMIT permits far fewer requests per HOUR than the inquiry tier', () => {
        // The whole reason the tier exists. Compare budgets over the same
        // period rather than the raw maxAttempts, because the two presets use
        // different windows — that difference IS the defect being fixed: 10 per
        // minute is 600 an hour, and every one of them emails the operator.
        const perHour = (c: { maxAttempts: number; windowMs: number }) =>
            (c.maxAttempts * 60 * 60 * 1000) / c.windowMs;

        expect(perHour(EXCHANGE_INQUIRY_LIMIT)).toBe(600);
        expect(perHour(INSURANCE_LEAD_LIMIT)).toBe(20);
        // A wide margin, so a future tweak that quietly restores a per-minute
        // window fails here rather than in the operator's inbox.
        expect(perHour(INSURANCE_LEAD_LIMIT)).toBeLessThan(perHour(EXCHANGE_INQUIRY_LIMIT) / 10);
    });

    it('API_KEY_CREATE_LIMIT is the tightest preset (most sensitive)', () => {
        expect(API_KEY_CREATE_LIMIT.maxAttempts).toBeLessThanOrEqual(
            LOGIN_LIMIT.maxAttempts
        );
        expect(API_KEY_CREATE_LIMIT.maxAttempts).toBeLessThanOrEqual(
            API_MUTATION_LIMIT.maxAttempts
        );
    });
});
