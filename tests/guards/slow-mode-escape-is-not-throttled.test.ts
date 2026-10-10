/**
 * P5.5a — the way OUT of slow mode must not itself be subject to slow mode
 * (#1596).
 *
 * Slow mode reduces the DEFAULT mutation budget for an account that is
 * unverified or less than a week old. Verifying an email address is how an
 * account leaves the unverified half — so if a verification route ever sat on
 * the default tier, an unverified account would be throttled on the exact
 * route that stops it being unverified. The tighter the slow tier got, the
 * harder that account would find it to escape.
 *
 * ## This holds TODAY for a reason that is easy to undo by accident
 *
 * Neither verification route uses `withApiErrorHandling`:
 *
 *   - `verify-email/route.ts` is a bare `GET`. The mutation limiter only
 *     covers POST/PUT/PATCH/DELETE, so it is doubly outside.
 *   - `verify-email/resend/route.ts` is a bare `POST` with its OWN per-email
 *     limiter (`checkCredentialsAttempt`, sharing the login bucket). That
 *     absence is the DESIGN, not an oversight — its docblock says the response
 *     must be uniform whether or not the rate limit tripped, because any
 *     variation leaks whether an address is registered, and
 *     `withApiErrorHandling` would answer 429.
 *
 * So the property is currently true by construction. A perfectly reasonable
 * future PR — "every route should be wrapped for consistent error handling" —
 * would silently break it, pass every other guard, and leave a trap that only
 * shows up for accounts in slow mode. Hence this file.
 *
 * ## What it permits
 *
 * Not wrapping at all, OR wrapping with an EXPLICIT `config`. The second is
 * fine because slow mode narrows the default tier only: a route that names its
 * own preset keeps it. What is refused is the default tier, which is the one
 * shape that produces the trap.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');

/**
 * The routes by which an account leaves slow mode's unverified half.
 *
 * Enumerated rather than derived, and that is a deliberate trade: a derived
 * population ("anything matching /verif/") would sweep in seven unrelated
 * routes (MFA enrolment, audit-log verification, farm-claim approval, file
 * integrity) that have nothing to do with email verification. The cost is that
 * a NEW escape route would not be covered — so the completeness test below
 * guards the list itself by requiring every entry to still exist.
 */
const ESCAPE_ROUTES = [
    'src/app/api/auth/verify-email/route.ts',
    'src/app/api/auth/verify-email/resend/route.ts',
    // The registration flow's own verify step. It already carries an explicit
    // LOGIN_LIMIT, which is allowed — see "What it permits".
    'src/app/api/auth/register/verify/route.ts',
];

function read(rel: string): string {
    return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('slow mode — the escape routes exist', () => {
    it.each(ESCAPE_ROUTES)('%s is a real file', (rel) => {
        // A renamed or deleted route would make every assertion below vacuous:
        // `readFileSync` on a missing path throws, but a silently EMPTY
        // population would pass. This is the half that keeps the enumerated
        // list honest.
        expect(existsSync(resolve(ROOT, rel))).toBe(true);
    });

    it('covers both halves of the email-verification flow', () => {
        // Consume AND re-issue. Covering only the consume route would leave a
        // farmer whose first email never arrived unable to request another.
        expect(ESCAPE_ROUTES.some((r) => r.endsWith('verify-email/route.ts'))).toBe(true);
        expect(ESCAPE_ROUTES.some((r) => r.includes('verify-email/resend'))).toBe(true);
    });
});

describe('slow mode — no escape route sits on the DEFAULT mutation tier', () => {
    it.each(ESCAPE_ROUTES)('%s is unwrapped, or names its own preset', (rel) => {
        const src = read(rel);
        const wrapped = src.includes('withApiErrorHandling');

        if (!wrapped) {
            // Nothing to check: the mutation limiter is not in this route's
            // path at all.
            expect(wrapped).toBe(false);
            return;
        }

        // Wrapped, so it MUST name a config. A wrapped route with no `config:`
        // takes `API_MUTATION_LIMIT`, which is precisely what slow mode
        // narrows — and this route is the way out of slow mode.
        expect(src).toMatch(/config:\s*[A-Z_]+_LIMIT/);
    });

    it('detects the defect it is written for', () => {
        // Mutation proof against a synthetic source, because the real files
        // are currently all compliant — so a green run above is also what a
        // detector that checks nothing produces.
        const trap = `
            import { withApiErrorHandling } from '@/lib/errors/api';
            export const POST = withApiErrorHandling(async () => new Response('{}'));
        `;
        const compliantUnwrapped = `
            export async function POST() { return new Response('{}'); }
        `;
        const compliantExplicit = `
            import { withApiErrorHandling } from '@/lib/errors/api';
            export const POST = withApiErrorHandling(async () => new Response('{}'), {
                rateLimit: { config: LOGIN_LIMIT, scope: 'x' },
            });
        `;

        const offends = (s: string) =>
            s.includes('withApiErrorHandling') && !/config:\s*[A-Z_]+_LIMIT/.test(s);

        expect(offends(trap)).toBe(true);
        expect(offends(compliantUnwrapped)).toBe(false);
        expect(offends(compliantExplicit)).toBe(false);
    });
});

describe('slow mode — the resend route keeps its own limiter', () => {
    it('still rate-limits per email, so being unwrapped is not unlimited', () => {
        // The reason this route may be unwrapped is that it limits itself. If
        // that limiter were ever removed, "unwrapped" would stop meaning
        // "deliberately outside the tier" and start meaning "an email-sending
        // POST with no ceiling" — an amplifier pointed at third-party inboxes.
        const src = read('src/app/api/auth/verify-email/resend/route.ts');
        expect(src).toContain('checkCredentialsAttempt');
    });
});
