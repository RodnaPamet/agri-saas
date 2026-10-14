/**
 * P6.10's four hardening requirements, pinned (#1818).
 *
 * The phase states them precisely, so they are quoted and each gets a case —
 * three here, and the fourth in
 * `tests/integration/p6-10-no-pii-on-public-surfaces.test.ts` because it needs
 * a database:
 *
 *   > A crawler/mutation test seeds ЕГН, ЕИК, УРН and address, and expects 0
 *   > hits in the HTML, JSON-LD, OG image or API.      ← the integration suite
 *   > Edge reachability with no cookie, while `/fx` stays protected.
 *   > The 61st anonymous request in a minute gets 429.
 *   > Unpublish → 404 within 60s.
 *
 * ## Two of these were already true, and saying so is the point
 *
 * `/fx stays protected` is satisfied by `matchesPublicPrefix`, which this
 * phase did not write — so the case below is a REGRESSION test for that
 * predicate, not evidence of work done here. I had it the other way round on
 * the issue, warning that `/f` would open `/fx`; that was the pre-#1770
 * `startsWith` behaviour and is corrected on #1814 and #1818.
 *
 * The 429 likewise: `PUBLIC_READ_LIMIT` is 60/min and predates P6, so the
 * public surfaces JOINED the tier that already had it rather than getting a
 * number chosen for them.
 *
 * Writing a requirement's test as though the phase satisfied it would be cover
 * for work nobody performed.
 */
import { isPublicPath, matchesPublicPrefix } from '@/lib/auth/guard';
import { isPublicReadRateLimited } from '@/lib/rate-limit/publicReadRateLimit';
import { PUBLIC_READ_LIMIT } from '@/lib/security/rate-limit';

describe('Edge reachability with no cookie, while /fx stays protected', () => {
    it('the public surface is reachable', () => {
        expect(isPublicPath('/f')).toBe(true);
        expect(isPublicPath('/f/pobeda')).toBe(true);
        expect(isPublicPath('/api/public/farms')).toBe(true);
    });

    it('/fx and its subtree stay protected', () => {
        expect(isPublicPath('/fx')).toBe(false);
        expect(isPublicPath('/fx/admin')).toBe(false);
        expect(isPublicPath('/f-debug')).toBe(false);
    });

    it('…and that is the PREDICATE’s doing, not this phase’s', () => {
        // Stated as a property of `matchesPublicPrefix` so the requirement is
        // anchored to the thing that actually holds it. A match must end at a
        // separator or at the end of the string.
        expect(matchesPublicPrefix('/f', '/f')).toBe(true);
        expect(matchesPublicPrefix('/f/pobeda', '/f')).toBe(true);
        expect(matchesPublicPrefix('/fx', '/f')).toBe(false);
        expect(matchesPublicPrefix('/f-debug', '/f')).toBe(false);
    });
});

describe('the 61st anonymous request in a minute gets 429', () => {
    it('the budget is 60 per minute', () => {
        // So the 61st is refused. Asserted on the config rather than by
        // issuing 61 requests: the limiter itself is exercised by the Edge
        // tests, and what this requirement needs is the NUMBER.
        expect(PUBLIC_READ_LIMIT.maxAttempts).toBe(60);
        expect(PUBLIC_READ_LIMIT.windowMs).toBe(60_000);
    });

    it('covers both public surfaces — the page and the API', () => {
        expect(isPublicReadRateLimited('GET', '/f/pobeda')).toBe(true);
        expect(isPublicReadRateLimited('GET', '/api/public/farms')).toBe(true);
    });

    it('does NOT cover the favicon, fonts, or /forgot-password', () => {
        // The reason `/f/` carries a trailing slash. This tier matches with
        // `startsWith`, so a bare `/f` would catch all three — measured, all
        // three are real served paths — and throttling a favicon and a font at
        // 60/min per IP breaks ordinary page loads.
        //
        // "Over-matching a rate limit is safe" is true of SAFETY and false of
        // AVAILABILITY: over-throttling leaks nothing and takes the product
        // down. Two failure directions, not one axis.
        expect(isPublicReadRateLimited('GET', '/favicon.ico')).toBe(false);
        expect(isPublicReadRateLimited('GET', '/fonts/Inter.woff2')).toBe(false);
        expect(isPublicReadRateLimited('GET', '/forgot-password')).toBe(false);
    });

    it('is GET-only, so a mutation is not claimed by a read tier', () => {
        expect(isPublicReadRateLimited('POST', '/f/pobeda')).toBe(false);
        expect(isPublicReadRateLimited('POST', '/api/public/farms')).toBe(false);
    });
});

describe('unpublish → 404 within 60s', () => {
    it('the page is force-dynamic, so there is no cache to outlive the row', async () => {
        // The 60s bound is only meetable if the page re-reads per request. A
        // statically generated page would keep serving a profile whose row is
        // already gone — and `revalidate: 60` would meet the letter of the
        // requirement while leaving a withdrawn farm visible for up to a
        // minute, which is the thing it is trying to prevent.
        const page = await import('@/app/f/[handle]/page');
        expect((page as { dynamic?: string }).dynamic).toBe('force-dynamic');

        const site = await import('@/app/sitemap');
        expect((site as { dynamic?: string }).dynamic).toBe('force-dynamic');
    });

    it('the row is DELETED on withdrawal, not flagged', () => {
        // Which is why there is no window at all, not merely a short one. The
        // behavioural proof is in the writer's integration suite; this pins
        // the shape the bound rests on.
        const fs = require('node:fs') as typeof import('node:fs');
        const src = fs.readFileSync('src/app-layer/usecases/public-farm-profile.ts', 'utf8');
        expect(src).toContain('publicFarmProfile.deleteMany');
        // A `published` column on the projection would mean a filter to
        // forget; there is none.
        expect(src).not.toMatch(/publicFarmProfile\.update\([^)]*published/);
    });
});
