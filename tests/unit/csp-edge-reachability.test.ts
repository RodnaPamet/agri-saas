/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these surfaces (see tests/unit/cors.test.ts). */

/**
 * A browser's CSP violation report must reach the sink instead of being 401'd.
 *
 * WHY THIS FILE EXISTS. `src/lib/security/csp.ts:184` puts `CSP_REPORT_PATH`
 * into `report-uri`, and `src/middleware.ts` puts the same constant into
 * `Report-To` and `Reporting-Endpoints`. A browser POSTs violation reports to
 * that path **without credentials** — the sink's own docblock says so:
 *
 *     - No CSRF token required (browser sends reports without credentials)
 *
 * So `getToken()` returns null, `isApiRoute()` is true, and the middleware
 * answered `unauthorizedJson()` — a 401 — before the handler ran. The same file
 * that advertises the endpoint refused it, a few hundred lines apart. No
 * violation report had ever reached the store since the feature shipped
 * (2026-03-21). Issue #704.
 *
 * NOTHING CAUGHT IT, and the near-misses are worth naming:
 *
 *   - `tests/unit/csp-reporting.test.ts` has 26 tests covering legacy + modern
 *     payload parsing, the rate limiter, the size cap and the ring buffer.
 *     Every one imports `csp-violations.ts` DIRECTLY. None crosses the Edge.
 *   - `tests/guardrails/security-hardening-epic.test.ts:202` reads the route
 *     file as source text.
 *   - `tests/guards/public-routes-self-authenticate.test.ts` derives its
 *     "must be reachable" set from routes that READ and VERIFY a credential.
 *     A report sink verifies nothing, so it is outside that derivation by
 *     construction — the guard is correct and blind to this class.
 *
 * That is the C.1a/C.1b shape a fourth time: `token.error`, the `iflk_` API
 * key and SCIM were all complete, unit-tested mechanisms severed at this exact
 * seam. The class the older guard misses is the UNCREDENTIALED BROWSER BEACON,
 * and it has exactly three members in this repo — see the last describe block.
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

import middleware, { config } from '../../src/middleware';
import { isPublicPath } from '../../src/lib/auth/guard';
import { CSP_REPORT_PATH } from '../../src/lib/security/csp';

/** A legacy `application/csp-report` body, as Chrome sends it. */
const LEGACY_REPORT = JSON.stringify({
    'csp-report': {
        'document-uri': 'https://app.example/t/acme/dashboard',
        'violated-directive': 'script-src',
        'blocked-uri': 'https://evil.example/x.js',
    },
});

function reportRequest(pathname = CSP_REPORT_PATH, contentType = 'application/csp-report') {
    // Deliberately NO cookie and NO authorization header: that is what a
    // browser sends for a violation report, and it is the whole point.
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: LEGACY_REPORT,
    });
}

beforeEach(() => {
    getToken.mockReset();
    // What actually happens in production: no session cookie is sent, so
    // next-auth yields null. This is the precondition of the whole bug.
    getToken.mockResolvedValue(null);
});

describe('the middleware matcher covers the report path at all', () => {
    it('compiles the REAL exported matcher and matches the report path', () => {
        // Built from `config.matcher` rather than restating the pattern, so a
        // change there is caught here instead of silently excluding the path
        // and making the rest of this file vacuous.
        const re = new RegExp(config.matcher[0]);
        expect(re.test(CSP_REPORT_PATH)).toBe(true);
    });
});

describe('an uncredentialed violation report passes the Edge', () => {
    it('is not refused by the middleware', async () => {
        const res = await middleware(reportRequest());
        // A pass-through is `NextResponse.next()`, which carries this header.
        // The failure mode being guarded is a 401 whose body is the Edge's
        // generic `{"error":"Unauthorized"}` — the exact response every real
        // browser report received for five months.
        expect(res.status).not.toBe(401);
        expect(res.headers.get('x-middleware-next')).toBe('1');
    });

    it.each(['application/reports+json', 'application/json'])(
        'also passes for the %s report format',
        async (contentType) => {
            const res = await middleware(reportRequest(CSP_REPORT_PATH, contentType));
            expect(res.status).not.toBe(401);
        },
    );

    it('the path derives from the constant that goes INTO the header', () => {
        // The invariant that cannot drift: the allowlist and the three
        // response headers read the same constant, so a renamed or re-pointed
        // endpoint stays covered with no edit here.
        expect(isPublicPath(CSP_REPORT_PATH)).toBe(true);
        expect(CSP_REPORT_PATH.startsWith('/api/')).toBe(true);
    });
});

describe('opening the sink did not open the app', () => {
    it('an ordinary API path is still refused without a session', async () => {
        // Resolving power. Without this, the assertions above are satisfied by
        // a middleware that stopped refusing anything at all.
        const res = await middleware(
            new NextRequest('http://localhost:3000/api/t/acme/journal', { method: 'GET' }),
        );
        expect(res.status).toBe(401);
    });

    it('a path that merely STARTS LIKE the sink is still refused', async () => {
        // Prefix matching is what `isPublicPath` does, so a sibling route
        // under a longer name would ride the same carve-out. There is none
        // today; this fails the moment one is added.
        const res = await middleware(
            new NextRequest('http://localhost:3000/api/security/mfa', { method: 'GET' }),
        );
        expect(res.status).toBe(401);
    });
});

describe('the uncredentialed-beacon class is enumerated, not sampled', () => {
    /**
     * Every path this app tells a browser to fetch WITHOUT credentials. The
     * class is small and closed, which is what makes this checkable rather
     * than aspirational:
     *
     *   · CSP_REPORT_PATH  — report-uri / Report-To / Reporting-Endpoints
     *   · /api/metrics     — `navigator.sendBeacon` in WebVitalsReporter.tsx
     *   · the PWA manifest — `<link rel="manifest">` defaults to no credentials
     *
     * A fourth member added without an allowlist entry is the next instance of
     * this bug.
     */
    it.each([
        [CSP_REPORT_PATH, 'CSP violation reports (report-uri / Report-To)'],
        ['/api/metrics', 'web-vitals RUM beacon (navigator.sendBeacon)'],
        ['/manifest.webmanifest', 'PWA manifest (<link rel="manifest">)'],
    ])('%s is reachable — %s', (pathname) => {
        expect(isPublicPath(pathname)).toBe(true);
    });
});
