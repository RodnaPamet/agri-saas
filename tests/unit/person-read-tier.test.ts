/**
 * P1.6 — the authenticated read tier covers PERSON paths (#1192).
 *
 * ## What was missing
 *
 * `isApiReadRateLimited` required an `/api/t/` prefix, so `/api/me/`,
 * `/api/social/` and `/api/account/` had **no read tier at all**. Their writes
 * were covered — the mutation tier lives in `withApiErrorHandling` — and
 * nothing covered their reads. P1.6 lists "read tier" among the parity items
 * and this was the one still outstanding; MFA parity and the operator rule had
 * already shipped.
 *
 * ## Why this file exists rather than more cases in person-path-parity
 *
 * That suite drives the middleware and asserts the MFA and terms gates. The
 * read tier is a different control with a different predicate, and a mutation
 * removing person paths from `isApiReadRateLimited` left it fully green —
 * measured. Two suites covering adjacent controls, and neither covering this
 * one.
 *
 * ## The population is DERIVED from `isPersonPath`
 *
 * `isPersonApiPath` calls that predicate rather than restating its prefixes, so
 * the read tier and the Edge gates cannot drift apart — which is the asymmetry
 * P1.6 exists to remove. These cases assert the two agree on the same inputs.
 */
import { isApiReadRateLimited } from '@/lib/rate-limit/apiReadRateLimit';
import { isPersonPath } from '@/lib/auth/guard';

describe('§1 person API reads are rate-limited', () => {
    it.each([
        '/api/me/farms',
        '/api/me/profile',
        '/api/social/blocks',
        '/api/social/reports',
        '/api/account/profile',
        '/api/account/language',
        '/api/account/bottom-tabs',
    ])('GET %s is covered', (p) => {
        expect({ path: p, limited: isApiReadRateLimited('GET', p) })
            .toEqual({ path: p, limited: true });
    });

    it('tenant reads are unaffected — this ADDED a population, it did not move one', () => {
        expect(isApiReadRateLimited('GET', '/api/t/acme/journal')).toBe(true);
    });
});

describe('§2 what it deliberately does NOT cover', () => {
    it('mutations, which have their own tier', () => {
        // `withApiErrorHandling` owns POST/PUT/PATCH/DELETE. Covering them here
        // too would mean two budgets on one request, the looser one invisible.
        for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            expect({ m, limited: isApiReadRateLimited(m, '/api/me/farms') })
                .toEqual({ m, limited: false });
        }
    });

    it('PAGES, which are person paths but not API reads', () => {
        // `/account/` and `/onboarding/` are `isPersonPath` and must stay out:
        // a page load is not an API read, and throttling navigation at the same
        // budget is a different decision nobody has made.
        for (const p of ['/account/security', '/onboarding/farm']) {
            expect({ path: p, person: isPersonPath(p), limited: isApiReadRateLimited('GET', p) })
                .toEqual({ path: p, person: true, limited: false });
        }
    });

    it('/api/account/export, which carries its own tighter budget', () => {
        // P5.6a gave it an inline `enforceRateLimit` because a GET cannot reach
        // the mutation tier. Letting the read tier apply as well would put two
        // budgets on one route — and an Art 15 export is the wrong place to
        // economise on requests.
        expect(isPersonPath('/api/account/export')).toBe(true);
        expect(isApiReadRateLimited('GET', '/api/account/export')).toBe(false);
    });

    it('health probes, so operators keep monitoring during an attack', () => {
        for (const p of ['/api/health', '/api/livez', '/api/readyz']) {
            expect(isApiReadRateLimited('GET', p)).toBe(false);
        }
    });
});

describe('§3 the read tier and the Edge gates agree on their population', () => {
    it('every person API path the gate sees, the tier sees', () => {
        // The drift this guards: `isPersonApiPath` derives from `isPersonPath`
        // rather than restating four prefixes, so a fifth added to the gate is
        // read-tiered automatically. If someone inlines the prefixes here, this
        // is what notices.
        const paths = [
            '/api/me/x', '/api/social/x', '/api/account/x',
        ];
        for (const p of paths) {
            expect({ path: p, person: isPersonPath(p), limited: isApiReadRateLimited('GET', p) })
                .toEqual({ path: p, person: true, limited: true });
        }
    });

    it('a sibling prefix is in NEITHER', () => {
        // `/api/accounts` is not `/api/account/`. A bare `startsWith('/api/account')`
        // would pull it into both, which is the boundary hazard the person-path
        // suite already pins for the gate side.
        for (const p of ['/api/accounts', '/api/accountsomething', '/api/mex']) {
            expect({ path: p, person: isPersonPath(p), limited: isApiReadRateLimited('GET', p) })
                .toEqual({ path: p, person: false, limited: false });
        }
    });
});
