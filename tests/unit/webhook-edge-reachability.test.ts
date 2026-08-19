/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these surfaces (see tests/unit/cors.test.ts). */

/**
 * A signed webhook must REACH its handler.
 *
 * ## The bug
 *
 * Stripe, the AV scanner and third-party integrations all POST with their
 * own credential — a Stripe signature, an HMAC over the raw body, a
 * per-connection secret — and none of them can carry a NextAuth session
 * cookie, because the sender is not a browser. So `getToken()` returned
 * null and `src/middleware.ts` answered `401 {"error":"Unauthorized"}`
 * before any handler ran. All three had never been delivered.
 *
 * Latent rather than live on the current deployment (Stripe unconfigured,
 * AV scanning disabled) — which is precisely what let it survive. It fails
 * SILENTLY on the day someone enables either: payments succeed, plan state
 * never changes, and nothing errors.
 *
 * ## What this file proves that the guard cannot
 *
 * `tests/guards/public-routes-self-authenticate.test.ts` asserts the paths
 * are in `PUBLIC_PATH_PREFIXES` — a claim about a list. This drives the
 * REAL middleware and asserts the request is passed onward, which is a
 * claim about behaviour. The list being right and the middleware behaving
 * are different facts; SCIM taught that the hard way.
 */
import { NextRequest } from 'next/server';

jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getToken(...a) }));

import middleware from '../../src/middleware';
import { isScimRateLimited } from '../../src/lib/rate-limit/scimRateLimit';

const WEBHOOKS = [
    ['/api/stripe/webhook', { 'stripe-signature': 't=1,v1=deadbeef' }],
    ['/api/storage/av-webhook', { 'x-av-signature': 'abc123' }],
    ['/api/integrations/webhooks/slack', { 'x-signature': 'abc123' }],
] as const;

function post(pathname: string, headers: Record<string, string>) {
    return new NextRequest(`http://localhost:3000${pathname}`, { method: 'POST', headers });
}

beforeEach(() => {
    getToken.mockReset();
    // The precondition of the whole bug: a webhook has no session cookie,
    // and next-auth cannot make a token out of a Stripe signature.
    getToken.mockResolvedValue(null);
});

describe('a signed webhook passes the Edge', () => {
    it.each(WEBHOOKS.map(([p, h]) => [p, h]))(
        'POST %s is not refused by the middleware',
        async (pathname, headers) => {
            const res = await middleware(post(pathname as string, headers as Record<string, string>));
            expect(res.status).not.toBe(401);
            // `NextResponse.next()` — the request was allowed onward.
            expect(res.headers.get('x-middleware-next')).toBe('1');
        },
    );

    it('still 401s an ordinary tenant route with no session', async () => {
        // Negative control. Without it, a middleware that stopped refusing
        // ANYTHING would satisfy every assertion above.
        const res = await middleware(post('/api/t/acme-corp/journal', {}));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('does NOT open the neighbouring paths', async () => {
        // `/api/stripe/webhook` is an exact prefix; `/api/integrations/`
        // is not opened wholesale, only its `webhooks/` subtree. A prefix
        // that leaks a sibling is the same class of bug as no gate at all.
        for (const pathname of [
            '/api/stripe/customers',
            '/api/integrations/connections',
            '/api/storage/upload',
        ]) {
            const res = await middleware(post(pathname, {}));
            expect(res.status).toBe(401);
        }
    });
});

describe('the webhooks are rate limited', () => {
    it.each(['/api/stripe/webhook', '/api/storage/av-webhook', '/api/integrations/webhooks/slack'])(
        '%s is in the tier',
        (pathname) => {
            // They are anonymous at the Edge now, so an unauthenticated
            // caller can reach a signature comparison — every miss costs a
            // DB read and a log line. Unbudgeted that is free load.
            expect(isScimRateLimited(pathname)).toBe(true);
        },
    );

    it('does not throttle the neighbours it must not claim', () => {
        expect(isScimRateLimited('/api/integrations/connections')).toBe(false);
        expect(isScimRateLimited('/api/t/acme/journal')).toBe(false);
    });
});
