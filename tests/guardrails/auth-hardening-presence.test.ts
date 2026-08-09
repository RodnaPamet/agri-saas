/**
 * Guardrail: Epic 1 security-validation closures stay in place.
 *
 * R-3 — signIn callback rejects OAuth profiles with email_verified=false.
 * R-6 — startup aborts in production when REDIS_URL is unset and rate
 *       limiting is not explicitly disabled.
 *
 * These two checks are small but load-bearing. A "simplify" PR that
 * collapses the email_verified branch (because it "looks redundant
 * since OAuth verifies anyway") would silently reintroduce a known
 * threat path. The Redis-required check guards the rate-limit
 * security practice from silently no-op'ing in prod.
 *
 * Static structural assertion: the relevant function bodies must
 * contain the load-bearing predicates.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('R-3: signIn rejects email_verified=false', () => {
    const auth = read('src/auth.ts');

    it('reads profile.email_verified in the signIn callback', () => {
        // Match the exact predicate so a refactor that removes the
        // === false comparison (e.g. tightens to truthy check) shows
        // up as a guardrail diff rather than a silent acceptance.
        expect(auth).toMatch(/profile\.email_verified === false/);
    });

    it('returns false from the signIn callback when the predicate hits', () => {
        // Within ~25 lines of the email_verified check there must be
        // an explicit `return false` — this is what NextAuth uses to
        // reject the sign-in.
        const idx = auth.indexOf('profile.email_verified === false');
        expect(idx).toBeGreaterThan(-1);
        const window = auth.slice(idx, idx + 1500);
        expect(window).toMatch(/return false/);
    });

    it('logs the rejection via edgeLogger.warn', () => {
        const idx = auth.indexOf('profile.email_verified === false');
        expect(idx).toBeGreaterThan(-1);
        const window = auth.slice(idx, idx + 1500);
        expect(window).toMatch(/edgeLogger\.warn/);
    });
});

describe('R-6: production startup requires REDIS_URL', () => {
    const instrumentation = read('src/instrumentation.ts');

    it('aborts in production when REDIS_URL is unset', () => {
        // The check guards on NODE_ENV=production AND REDIS_URL absence.
        // The previous RATE_LIMIT_ENABLED=0 escape hatch was removed
        // (see src/instrumentation.ts docblock) because Redis underpins
        // more than the rate limiter — login throttle, invite redemption,
        // email dispatch, and BullMQ all break silently when Redis is
        // absent. Toggling rate limits off doesn't make Redis optional.
        expect(instrumentation).toMatch(/NODE_ENV === 'production'/);
        expect(instrumentation).toMatch(/!process\.env\.REDIS_URL/);
    });

    it('exits the process (no silent degrade)', () => {
        // The whole point: visible failure, not "degraded service".
        expect(instrumentation).toMatch(/process\.exit\(1\)/);
    });

    it('emits a FATAL message that names the missing env var', () => {
        // Operators triaging a failed startup need the env var name in
        // the log line. Asserts the message itself is informative.
        expect(instrumentation).toMatch(/FATAL.*REDIS_URL.*required/);
    });
});
