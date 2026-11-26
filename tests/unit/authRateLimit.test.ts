import { NextRequest } from 'next/server';
import { checkAuthRateLimit } from '@/lib/rate-limit/authRateLimit';

describe('Auth Rate Limit Module', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        // Force the environment to memory mode for testing
        process.env.RATE_LIMIT_ENABLED = '1';
        process.env.RATE_LIMIT_MODE = 'memory';
        // Ensure rate limiting is NOT skipped (AUTH_TEST_MODE bypasses rate limiting)
        delete process.env.AUTH_TEST_MODE;
        // Several tests deliberately exceed the limit to verify blocking; silence
        // the expected structured warn so it doesn't pollute test output.
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    function createMockRequest(path: string, ip: string = '127.0.0.1') {
        const req = new NextRequest(`http://localhost${path}`);
        // Mocking IP directly isn't possible on NextRequest, so we mock headers
        req.headers.set('x-forwarded-for', ip);
        req.headers.set('user-agent', 'test-agent');
        return req;
    }

    it('allows a low risk request and returns headers', async () => {
        const req = createMockRequest('/api/auth/csrf', '1.1.1.1');
        const result = await checkAuthRateLimit(req);

        expect(result.ok).toBe(true);
        expect(result.headers).toBeDefined();
        expect(result.headers?.get('X-RateLimit-Limit')).toBe('60');
    });

    it('blocks a high risk request after 10 tries', async () => {
        const ip = '2.2.2.2';

        // 10 successful requests
        for (let i = 0; i < 10; i++) {
            const req = createMockRequest('/api/auth/signin', ip);
            const result = await checkAuthRateLimit(req);
            expect(result.ok).toBe(true);
        }

        // 11th should fail
        const req11 = createMockRequest('/api/auth/signin', ip);
        const result11 = await checkAuthRateLimit(req11);

        expect(result11.ok).toBe(false);
        expect(result11.response).toBeDefined();

        // Check 429 response formatting
        expect(result11.response?.status).toBe(429);
        const data = await result11.response?.json();
        expect(data.error).toBe('RATE_LIMITED');
        expect(data.retryAfterSeconds).toBeGreaterThan(0);

        const headers = result11.response?.headers;
        expect(headers?.get('Retry-After')).toBeDefined();
    });

    it('isolates tiers: exhausting high risk does not exhaust low risk', async () => {
        const ip = '3.3.3.3';

        // Exhaust High risk
        for (let i = 0; i < 11; i++) {
            await checkAuthRateLimit(createMockRequest('/api/auth/signin', ip));
        }

        const highResult = await checkAuthRateLimit(createMockRequest('/api/auth/signin', ip));
        expect(highResult.ok).toBe(false);

        // Low risk should still be fine
        const lowResult = await checkAuthRateLimit(createMockRequest('/api/auth/csrf', ip));
        expect(lowResult.ok).toBe(true);
    });

    it('isolates IPs: exhausting limit for IP A does not affect IP B', async () => {
        const ipA = '4.4.4.4';
        const ipB = '5.5.5.5';

        // Exhaust High risk for IP A
        for (let i = 0; i < 11; i++) {
            await checkAuthRateLimit(createMockRequest('/api/auth/signin', ipA));
        }

        // IP B should be fine
        const resultB = await checkAuthRateLimit(createMockRequest('/api/auth/signin', ipB));
        expect(resultB.ok).toBe(true);
    });

    it('disables completely if RATE_LIMIT_ENABLED is 0', async () => {
        process.env.RATE_LIMIT_ENABLED = '0';
        const req = createMockRequest('/api/auth/signin', '6.6.6.6');
        const result = await checkAuthRateLimit(req);

        expect(result.ok).toBe(true);
        expect(result.headers).toBeUndefined();
    });

    /**
     * The native handoff GETs sit in the 'high' tier — #3155.
     *
     * They used to declare `rateLimit: { config: LOGIN_LIMIT }` in
     * `withApiErrorHandling`, which `resolveRateLimitScope` discards for any
     * non-mutation method, so the control never ran and the effective limit
     * was this module's DEFAULT 'low' tier — 60/min, the tier whose own
     * comment says it is meant for `/csrf` and `/providers`, "getters that
     * leak nothing". `complete` and `adopt` consume single-use server-held
     * tokens, so they are not that.
     *
     * Asserted through the LIMIT HEADER rather than by exhausting the bucket:
     * the header is what the tier decides, and a test that spent 10 requests
     * per path would be slow and would couple to the window.
     */
    describe('the native handoff GETs are high-tier (#3155)', () => {
        it.each([
            ['/api/auth/native/start', '2.0.0.1'],
            ['/api/auth/native/complete', '2.0.0.2'],
            ['/api/auth/native/adopt', '2.0.0.3'],
        ])('%s is capped at 10/min', async (path, ip) => {
            const result = await checkAuthRateLimit(createMockRequest(path, ip));
            expect(result.headers?.get('X-RateLimit-Limit')).toBe('10');
        });

        it('CONTROL — a leak-nothing getter is still 60/min, so the tier is not global', async () => {
            // Without this, classifying EVERYTHING as high would satisfy the
            // three cases above.
            const result = await checkAuthRateLimit(createMockRequest('/api/auth/csrf', '2.0.0.9'));
            expect(result.headers?.get('X-RateLimit-Limit')).toBe('60');
        });

        it('CONTROL — the four POSTs in the same directory are deliberately NOT included', async () => {
            // `apple`, `exchange`, `mfa` and `revoke` are arguably the same
            // class, and widening past the owner's 2026-11-26 ruling is not
            // #3155's to do — `mfa` in particular has real retry behaviour a
            // tightening would affect. Pinned so the omission is a recorded
            // decision rather than something that looks forgotten.
            const result = await checkAuthRateLimit(createMockRequest('/api/auth/native/mfa', '2.0.0.8'));
            expect(result.headers?.get('X-RateLimit-Limit')).toBe('60');
        });
    });
});
