/**
 * The CSP violation summary is gated IN THE HANDLER, and this is the assertion
 * that actually holds it (#704).
 *
 * WHY A SEPARATE, EXECUTING TEST. The obvious backstop is direction B of
 * `tests/guards/public-routes-self-authenticate.test.ts` — "every API route
 * behind a public prefix authenticates itself". It does not hold this. I
 * mutation-tested it: comment out the `verifyPlatformApiKey(request)` CALL and
 * the guard stays green, because its `VERIFIES` regex matches the file's TEXT,
 * and the import plus the surrounding docblock still mention the symbol. The
 * guard is file-granular and source-text based; a disabled gate reads exactly
 * like a live one.
 *
 * That matters more here than almost anywhere, because of the order the two
 * halves of #704 interact:
 *
 *   · Before the fix, `/api/security/csp-report` was NOT in
 *     `PUBLIC_PATH_PREFIXES`, so the Edge 401'd the POST sink and the ring
 *     buffer stayed permanently empty. The GET returned nothing worth having.
 *   · Fixing the POST — which is the whole point, browsers cannot send a
 *     session cookie with a violation report — fills the buffer AND opens this
 *     method, because `isPublicPath` matches on prefix, not on method.
 *
 * So the reachability fix is precisely what ARMS this endpoint. What it serves
 * is `getViolationSummary(50)` → `recentViolations: CspViolation[]`, the whole
 * objects including `clientIp` and `userAgent`, from a single GLOBAL 500-entry
 * ring with no tenant scoping. Its previous protection was a comment:
 *
 *     // NOTE: This route is protected by the middleware auth guard.
 *     // Only authenticated users can access /api/* routes.
 *
 * — a bar of "any authenticated user of any tenant", which the prefix change
 * would have lowered to "anyone at all".
 */
import { NextRequest } from 'next/server';

const HEADER = 'x-platform-admin-key';
const REAL_KEY = 'k'.repeat(48); // pragma: allowlist secret

function makeReq(headerValue?: string): NextRequest {
    const headers = new Headers();
    if (headerValue !== undefined) headers.set(HEADER, headerValue);
    return {
        headers,
        nextUrl: new URL('http://localhost:3000/api/security/csp-report'),
    } as unknown as NextRequest;
}

/** Load the route with a chosen platform-admin key configuration. */
function loadRoute(key: string | undefined) {
    jest.resetModules();
    jest.doMock('@/env', () => ({
        env: {
            PLATFORM_ADMIN_API_KEY: key,
            PLATFORM_ADMIN_API_KEY_PREVIOUS: undefined,
        },
    }));
    return require('@/app/api/security/csp-report/route') as {
        GET: (req: NextRequest) => Promise<Response>;
    };
}

describe('GET /api/security/csp-report requires the platform-admin key', () => {
    it('401s with no key header', async () => {
        const { GET } = loadRoute(REAL_KEY);
        const res = await GET(makeReq());
        expect(res.status).toBe(401);
    });

    it('401s with a wrong key', async () => {
        const { GET } = loadRoute(REAL_KEY);
        const res = await GET(makeReq('x'.repeat(48)));
        expect(res.status).toBe(401);
    });

    it('401s with a right-length-but-wrong key (constant-time path)', async () => {
        // Length equality is the branch that reaches `timingSafeEqual`; a
        // wrong key of the SAME length must still be refused.
        const { GET } = loadRoute(REAL_KEY);
        const res = await GET(makeReq('j'.repeat(48)));
        expect(res.status).toBe(401);
    });

    it('503s when no platform-admin key is configured — fails CLOSED', async () => {
        // The deployment where this matters: an operator who never set
        // PLATFORM_ADMIN_API_KEY must not get an OPEN endpoint by omission.
        const { GET } = loadRoute(undefined);
        const res = await GET(makeReq(REAL_KEY));
        expect(res.status).toBe(503);
    });

    it('200s with the correct key — the gate is passed, not permanently shut', async () => {
        // Resolving power. Without this, every assertion above is satisfied by
        // a handler that returns 401 unconditionally.
        const { GET } = loadRoute(REAL_KEY);
        const res = await GET(makeReq(REAL_KEY));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { bufferSize: number; recentViolations: unknown[] };
        expect(body).toHaveProperty('bufferSize');
        expect(Array.isArray(body.recentViolations)).toBe(true);
    });

    it('never leaks the summary on a refusal', async () => {
        // The payload carries clientIp + userAgent for every reporter. A
        // refusal must carry none of it — not a truncated preview, not counts.
        const { GET } = loadRoute(REAL_KEY);
        const res = await GET(makeReq('wrong'));
        const body = await res.text();
        expect(body).not.toContain('recentViolations');
        expect(body).not.toContain('bufferSize');
        expect(body).not.toContain('clientIp');
    });
});
