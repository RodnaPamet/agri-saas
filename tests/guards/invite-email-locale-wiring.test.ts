/**
 * Every `sendInviteEmail` call site resolves the INVITER's language (#722).
 *
 * ## Why a guard here and an executing test everywhere else
 *
 * `invite-email-locale.test.ts` drives the email module and the resolver for
 * real — those are the mechanisms. This covers the CALL SITES, and it is the
 * fourth time in this work that the seam turned out to be the uncovered half:
 * #715's token-exchange budget, #723's `enqueueEmail` seam, #726's digest
 * dispatcher, and now this. Each was found by mutating the call site rather
 * than the mechanism, and each was green until a test existed at that layer.
 *
 * The honest reason this one is structural rather than executing: exercising
 * these three routes means mocking `requirePermission`, the rate limiter and
 * `createInviteToken`, for a payload whose only interesting property is one
 * argument. The risk that actually matters is a FOURTH invite route added
 * later without the wiring — and a filesystem-derived scan catches that the
 * moment the file exists, which no amount of mocking the current three would.
 *
 * That trade is a judgement, not a convention: a guard proves the call is
 * written, never that it works. What it works is proven next door.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const API_DIR = path.join(ROOT, 'src/app/api');

/** Every `route.ts` under the API tree, filesystem-derived. */
function routeFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) routeFiles(full, acc);
        else if (entry.name === 'route.ts') acc.push(full);
    }
    return acc;
}

/** Routes that actually send an invite email. */
function inviteSenders(): Array<{ rel: string; src: string }> {
    return routeFiles(API_DIR)
        .map((f) => ({ rel: path.relative(ROOT, f), src: fs.readFileSync(f, 'utf8') }))
        .filter((f) => f.src.includes('sendInviteEmail('));
}

describe('invite emails resolve the inviter locale at every call site', () => {
    it('finds the senders it is meant to be guarding', () => {
        // Anti-vacuity: an empty set would make every assertion below pass.
        // Three today — tenant invites, tenant members, org invites.
        expect(inviteSenders().length).toBeGreaterThanOrEqual(3);
    });

    it.each(inviteSenders().map((f) => f.rel))('%s passes an inviter-resolved locale', (rel) => {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        expect(src).toContain('inviterLocale(');
        // AWAITED and passed as `locale` — not merely imported. A bare
        // `inviterLocale(...)` would hand a Promise to a string field.
        expect(src).toMatch(/locale:\s*await\s+inviterLocale\(/);
    });

    it('nobody hardcodes a locale into an invite', () => {
        // The failure this is really about: a fourth route added later that
        // copies the shape but writes `locale: 'en'` because that was easier
        // than finding the inviter. Against a user base that is four-fifths
        // Bulgarian, that ships the wrong language silently.
        for (const { rel, src } of inviteSenders()) {
            const block = src.slice(src.indexOf('sendInviteEmail('));
            expect(`${rel}: ${/locale:\s*['"]/.test(block)}`).toBe(`${rel}: false`);
        }
    });

    it('the resolver itself fails SOFT, which is why a call site may await it', () => {
        // If `inviterLocale` could throw, awaiting it inside the argument list
        // would take down invite creation — an invite row that is already
        // committed, for an admin who has been told the email went out.
        const src = fs.readFileSync(path.join(ROOT, 'src/lib/email/inviter-locale.ts'), 'utf8');
        expect(src).toMatch(/catch\s*\(/);
        expect(src).toContain('RECIPIENT_FALLBACK_LOCALE');
        expect(src).not.toMatch(/throw\s+err/);
    });
});
