/**
 * Guard: no API route resolves a session with a raw `auth()` (#1652).
 *
 * ## The gap, and why the doc invited it
 *
 * P5.9 put `isAccountSuspended` in `getSessionOrThrow`, and CLAUDE.md describes
 * that as "the Node choke point — all three ctx resolvers call it". Both halves
 * are true. Neither is the same claim as "every authenticated request", which
 * is what the sentence invites a reader to conclude — and **ten route files
 * resolved a session with `await auth()` directly**, so `isAccountSuspended`
 * had exactly one caller. A suspended account could still:
 *
 *   - accept an invite and **join a second farm**, carrying on there under a
 *     fresh membership (four routes: both invite previews' POST halves and both
 *     `accept-redirect` handlers);
 *   - **rotate its own password**;
 *   - accept terms, read its own identity, read a promotion image;
 *   - and be handed `deletion` by `/api/auth/me`, which is how agrent-ios found
 *     it: a terminated person would sign in, be shown «Възстанови профила», and
 *     have the cancel refused 403 by the route that DOES check. A recovery
 *     screen offering an action the server would never honour.
 *
 * That last one was fixed by #1654 while this change was open, and NOT by this
 * gate: it reads `suspendedAt` off the `User` row the route already queries,
 * which costs nothing where a second lookup would. It is in the allowlist as a
 * `selfChecks` entry rather than migrated. So the population this closes is
 * NINE routes, and the tenth is covered by a cheaper mechanism.
 *
 * ## A count nobody printed, for the second time in this phase
 *
 * `count-the-routes-a-gate-covers` is the lesson, and the shape recurs: a
 * mechanism correctly placed at one choke point, and a population that does not
 * all pass through it. `public-routes-self-authenticate` exists for the inverse
 * — a credential the Edge 401s before any handler runs — and CLAUDE.md counts
 * seven prior instances of "a working mechanism severed at a seam". So the fix
 * is a door plus a DENOMINATOR, printed on every run, and `native-bearer-auth-
 * parity` is the precedent for holding a raw-helper count at zero: that is how
 * that class stopped recurring.
 *
 * ## The population is derived from disk
 *
 * Every `route.ts` under `src/app/api`, walked rather than listed, so route 273
 * is in scope the moment it exists. And the count of `auth()` calls OUTSIDE
 * that tree is printed too, deliberately: this guard does NOT cover server
 * components, and a number next to the claim is the difference between a scope
 * and a blind spot.
 *
 * ## Comments are blanked
 *
 * The exempted route carries a comment saying it uses the raw `auth()` on
 * purpose, and this very docblock names the function repeatedly. `blankNonCode`
 * first, or a guard about a fixed class reports every explanation of it as an
 * instance — `a-scar-is-not-a-wound`.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/** `await auth()` / `auth()` — the raw NextAuth session resolver. */
const RAW_AUTH = /(?<![A-Za-z0-9_$.])auth\s*\(\s*\)/g;

/**
 * The two doors in `@/lib/auth/session-gate`.
 *
 * The parameter list is NOT required to be empty. It was —
 * `\(\s*\)` — and #1656 gave `authRefusingSuspended` an optional refusal
 * record, so the two invite-acceptance routes started calling it with an
 * argument and **stopped being counted as gated**. The count fell from 9 to 8
 * and tripped the floor below, which is the only reason it was noticed.
 *
 * That is the `a-needle-loses-the-thread-at-a-rename` shape with an argument
 * instead of a rename: the call was still there, still the gate, and the
 * detector had gone blind to it. A detector for "does this route use the gate"
 * must not care what the gate is passed.
 */
const GATE = /\bauth(?:RefusingSuspended|WithSuspension)\s*\(/g;

/**
 * Routes allowed to call the raw `auth()`.
 *
 * Two KINDS, and the distinction is checked rather than trusted:
 *
 *   `selfChecks: true`   the route refuses a suspended account ITSELF, by some
 *                        other mechanism. The test below requires its source to
 *                        name `ACCOUNT_SUSPENDED`, so an entry cannot quietly
 *                        become an exemption when the inline check is removed.
 *   `selfChecks: false`  a suspended account is deliberately NOT refused. The
 *                        test requires the source NOT to name the code, so the
 *                        two kinds cannot blur into each other.
 *
 * "It is only a read" is not a reason — `offline/whoami` and the promotion
 * image are reads, and both went through the gate.
 */
interface Exemption {
    reason: string;
    selfChecks: boolean;
}

const ALLOWLIST: Readonly<Record<string, Exemption>> = {
    'src/app/api/t/[tenantSlug]/security/mfa/challenge/verify/route.ts': {
        selfChecks: false,
        reason:
            'Owner ruling, #1652. Part of SIGN-IN: refusing a suspended account at ' +
            'the MFA step surfaces as a failure on the code entry and reads as "your ' +
            'code is wrong" rather than "your account is suspended". The challenge ' +
            'is allowed to succeed and the first real request refuses with the ' +
            'sentence that explains it. Migrating this route is a product change.',
    },
    'src/app/api/auth/me/route.ts': {
        selfChecks: true,
        reason:
            'Refuses a suspended account INLINE, off the `User` row it already ' +
            'queries (#1654, landed by the parallel session while #1652 was open). ' +
            'That is better than this gate for this one route: the row is being ' +
            'fetched anyway, so reading `suspendedAt` from it costs nothing, while ' +
            '`authRefusingSuspended` would add a second lookup. It is covered by a ' +
            'different mechanism, NOT uncovered — `tests/unit/auth-me-deletion-' +
            'pending.test.ts` executes it, and `selfChecks` makes the claim ' +
            'checkable here rather than a sentence nobody re-reads.',
    },
};

describe('API routes resolve sessions through the suspension gate (#1652)', () => {
    const files = collectSourceFiles({
        roots: ['src/app/api'],
        extensions: ['.ts'],
        exclude: (rel) => !rel.endsWith('/route.ts'),
        // 386 route files, measured. NOT the 273 CLAUDE.md quotes for
        // `getTenantCtx` — that is the tenant-route population and this is
        // every API route. A floor near reality catches
        // an exclude predicate that ate the population rather than reporting
        // it clean — an empty selection passes every assertion below.
        floor: 200,
    });

    const raw: string[] = [];
    let gateCalls = 0;

    for (const abs of files) {
        const rel = relative(REPO_ROOT, abs);
        const code = blankNonCode(readFileSync(abs, 'utf8'));
        gateCalls += [...code.matchAll(GATE)].length;
        // The gate's own names END in `(` too, so count raw hits only after
        // removing them — `authRefusingSuspended()` must not read as `auth()`.
        // The lookbehind in RAW_AUTH already handles that; this asserts it.
        if (RAW_AUTH.test(code.replace(GATE, 'GATE()'))) raw.push(rel);
        RAW_AUTH.lastIndex = 0;
    }

    it('prints the denominator, including what it does NOT cover', () => {
        // Server components and pages are out of scope — stated with a number
        // beside it, because a scope without one is a blind spot.
        const outside = collectSourceFiles({
            roots: ['src/app'],
            extensions: ['.ts', '.tsx'],
            exclude: (rel) => rel.startsWith('src/app/api/'),
            floor: 50,
        }).filter((abs) =>
            RAW_AUTH.test(blankNonCode(readFileSync(abs, 'utf8')).replace(GATE, 'GATE()')),
        );
        console.log(
            `[api-routes-resolve-sessions-through-the-gate] ${files.length} route files; ` +
                `${gateCalls} gate call(s); ${raw.length} raw auth() route(s) ` +
                `(${Object.keys(ALLOWLIST).length} allowlisted). ` +
                `OUT OF SCOPE: ${outside.length} non-API file(s) under src/app call auth().`,
        );
        expect(files.length).toBeGreaterThan(200);
        // The gate has to be WIRED, or "zero raw callers" is satisfied by a
        // tree where nothing authenticates at all.
        //
        // Raised 9 -> 10 at #1656's two invite-acceptance calls. To the LIVE
        // count rather than left with slack: this floor is the only thing that
        // noticed the detector above going blind, and it could only notice
        // because it had none.
        expect(gateCalls).toBeGreaterThanOrEqual(10);
    });

    it('has no unexcused raw auth() call', () => {
        const unexcused = raw.filter((f) => !(f in ALLOWLIST));
        if (unexcused.length > 0) {
            throw new Error(
                `${unexcused.length} API route(s) resolve a session with a raw ` +
                    `auth() and so never reach the suspension check:\n\n` +
                    unexcused.map((f) => `  ${f}`).join('\n') +
                    `\n\nUse authRefusingSuspended() from @/lib/auth/session-gate — it ` +
                    `returns the session unchanged, null included, so your own ` +
                    `unauthenticated branch is untouched — or authWithSuspension() if ` +
                    `the route must not throw (a bare GET a browser navigates to). If ` +
                    `NOT refusing is deliberate, add an ALLOWLIST entry saying what the ` +
                    `refusal would cost.`,
            );
        }
        expect(unexcused).toEqual([]);
    });

    it('carries a substantive reason for every allowlist entry', () => {
        for (const [path, { reason }] of Object.entries(ALLOWLIST)) {
            expect(path).toMatch(/^src\/app\/api\/.+\/route\.ts$/);
            expect(reason.trim().length).toBeGreaterThan(120);
        }
    });

    it('holds each entry to the KIND it claims', () => {
        // The half that makes `selfChecks` worth more than a comment. A route
        // excused as "it checks itself" must still contain the refusal; one
        // excused as a deliberate carve-out must not, or the entry is
        // describing a route that no longer exists as described.
        for (const [path, { selfChecks }] of Object.entries(ALLOWLIST)) {
            const src = blankNonCode(readFileSync(`${REPO_ROOT}/${path}`, 'utf8'));
            expect(src.includes('ACCOUNT_SUSPENDED')).toBe(selfChecks);
        }
    });

    it('has no stale allowlist entry', () => {
        // Removes the cover the moment the route stops calling auth() — or
        // stops existing.
        for (const path of Object.keys(ALLOWLIST)) {
            expect(raw).toContain(path);
        }
    });

    // ── The teeth ────────────────────────────────────────────────────────
    //
    // One live raw caller and it is allowlisted, so the assertion above runs
    // over an empty unexcused set. These prove the detector still separates
    // the two shapes.
    describe('the detector', () => {
        const hits = (src: string): number => {
            const code = blankNonCode(src).replace(GATE, 'GATE()');
            const n = [...code.matchAll(RAW_AUTH)].length;
            return n;
        };

        it('finds the shape #1652 was about', () => {
            expect(hits('const session = await auth();')).toBe(1);
            expect(hits('const s = auth();')).toBe(1);
            expect(hits('const s = await auth()\n')).toBe(1);
        });

        it('does NOT read either gate call as a raw auth()', () => {
            // `authRefusingSuspended()` CONTAINS neither `auth()` nor a word
            // boundary before one, but a naive /auth\(\)/ would still miss that
            // and a naive /\bauth\(/ would match `authWithSuspension(`. Both
            // directions pinned.
            expect(hits('const session = await authRefusingSuspended();')).toBe(0);
            expect(hits('const { session } = await authWithSuspension();')).toBe(0);
        });

        it('does not match a method named auth on something else', () => {
            expect(hits('await provider.auth();')).toBe(0);
            expect(hits('await myAuth();')).toBe(0);
        });

        it('ignores a COMMENT that names the call', () => {
            expect(hits('// DELIBERATELY the raw `auth()`, see #1652.')).toBe(0);
            expect(hits('/**\n * resolved its own session with `auth()`.\n */')).toBe(0);
        });
    });
});
