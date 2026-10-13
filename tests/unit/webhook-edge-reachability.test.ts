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
    // Resend's delivery feed (#1753). Headers are Svix's, which is why the
    // sibling guard's CREDENTIAL_HEADERS regex does not recognise it — a
    // `svix-signature` is not an `x-signature`, and the handler is what
    // declares this route self-authenticating.
    ['/api/webhooks/resend', { 'svix-id': 'msg_1', 'svix-signature': 'v1,abc' }],
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
            // The Resend entry is PUBLIC_PATH_EXACT, deliberately not an
            // `/api/webhooks/` prefix — so a second webhook added next to it
            // stays session-gated until someone opens it on purpose. This is
            // the assertion that makes that a property rather than an
            // accident of there being only one.
            '/api/webhooks/other',
            '/api/webhooks/resend/replay',
        ]) {
            const res = await middleware(post(pathname, {}));
            expect(res.status).toBe(401);
        }
    });
});

describe('the platform-admin API reaches its handlers', () => {
    it('a key-bearing, cookie-less request is not refused by the Edge', async () => {
        // The documented caller: an operator with curl and
        // `x-platform-admin-key`. It carries no session cookie, so getToken()
        // returns null — and every one of these routes was 401'd before
        // `verifyPlatformApiKey` could run. Confirmed by probe before the fix.
        for (const pathname of [
            '/api/admin/tenants',
            '/api/admin/agri-events',
            '/api/admin/support-schemes',
            '/api/admin/news-derived-events',
        ]) {
            const res = await middleware(
                new NextRequest(`http://localhost:3000${pathname}`, {
                    method: 'POST',
                    headers: { 'x-platform-admin-key': 'k' },
                }),
            );
            expect(res.status).not.toBe(401);
            expect(res.headers.get('x-middleware-next')).toBe('1');
        }
    });

    it('leaves /api/admin/diagnostics behind the session gate', async () => {
        // Different auth model under the same path root: diagnostics uses
        // getLegacyCtx + permissions.canAdmin, i.e. an admin SESSION. Opening
        // the whole /api/admin/ prefix would have stripped its Edge role-floor
        // for no benefit — the fail-closed guard caught that, and this pins
        // the narrower carve-out so a future "simplify to one prefix" fails.
        const res = await middleware(
            new NextRequest('http://localhost:3000/api/admin/diagnostics', {
                headers: { 'x-platform-admin-key': 'k' },
            }),
        );
        expect(res.status).toBe(401);
    });
});

describe('the webhooks are rate limited', () => {
    it.each([
        '/api/stripe/webhook',
        '/api/storage/av-webhook',
        '/api/integrations/webhooks/slack',
        '/api/webhooks/resend',
        '/api/admin/tenants',
    ])(
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
        // The Resend entry is matched EXACTLY, so it claims neither a sibling
        // webhook nor a child path — the limiter's scope cannot be wider than
        // the Edge carve-out it defends.
        //
        // The child case is the one that caught a real defect: as a
        // `startsWith` entry this budgeted `/api/webhooks/resend/replay` and
        // `/api/webhooks/resendfoo`, and the carve-out itself had the same
        // widening. A sibling assertion alone passed in both worlds.
        expect(isScimRateLimited('/api/webhooks/other')).toBe(false);
        expect(isScimRateLimited('/api/webhooks/resend/replay')).toBe(false);
        expect(isScimRateLimited('/api/webhooks/resendfoo')).toBe(false);
    });
});
