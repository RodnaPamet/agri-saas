/**
 * Every person-scoped API route authenticates with `getUserCtx` (#1579).
 *
 * `getUserCtx` was complete, documented and unit-tested from P1.5 and had
 * **zero call sites under `src/app/api`** until #1578. Every person-scoped
 * route used bare `auth()` instead, and therefore skipped the three refusals
 * the helper exists to make — its own docblock enumerates them:
 *
 *   1. **An `iflk_` API key presented as a person credential.** Thrown before
 *      any session work, because "silently serving the cookie's user to a
 *      request that presented a key would answer as the wrong principal".
 *      With bare `auth()` the key is ignored and the cookie's user answers.
 *   2. **An MFA-pending session.** Defence in depth since P1.6 put person
 *      paths behind the Edge gate, and the only handler-side layer for a
 *      non-browser client.
 *   3. **The operator-only persona on a social surface.** The middleware's
 *      MECHANISATOR lockdown keys on the tenant slug in the URL, and a
 *      person-scoped path has none — so that lockdown "cannot fire here at
 *      all".
 *
 * Nothing was broken and nothing failed: the mechanism was built, tested, and
 * then not mounted. The unit tests passed because they call the helper
 * directly; the routes passed because `auth()` is a legitimate function. No
 * guard asked whether the two had ever met. That is what this file is for.
 *
 * ## Why the population is DERIVED
 *
 * A hand-listed guard would pass for ever while a seventh route appeared.
 * Measured when this landed: 7 person-scoped route files, 10 handlers.
 *
 * ## Why it reads CODE
 *
 * Every migrated route carries a comment saying "`getUserCtx`, not `auth()`",
 * which contains the literal `auth()`. Three existing assertions in
 * `avatar-renderer-convergence` and `ui-profile-name-capture` pinned
 * `/\bauth\(\)/` on raw source, and after the migration one of them still
 * PASSED — on the comment. Green, and asserting nothing. So this strips
 * comments with `blankNonCode` before deciding anything.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT as ROOT } from '../helpers/collect-files';

/**
 * Person-scoped prefixes: no `[tenantSlug]` in the path, so no tenant to scope
 * to and no `requirePermission` to apply — authorisation is "are you signed
 * in", and the subject is always the session user.
 *
 * `social` is listed before it exists, because the social roadmap builds there
 * and a prefix added only once the first route lands is a prefix somebody
 * forgets. That is why the collection below scans ALL of `src/app/api` and
 * FILTERS, rather than scanning these as roots: `collectSourceFiles` throws on
 * a root that does not exist (#875 — a renamed root would scan zero files and
 * pass), which is correct for it and wrong for a prefix that is deliberately
 * ahead of the code. Same shape as `social-routes-are-flag-gated`.
 *
 * Deliberately NOT "every api route without a tenant segment": `/api/auth/**`,
 * `/api/health` and the webhook routes have no tenant either and must not use
 * `getUserCtx` — they authenticate differently or not at all. A positive list
 * of person prefixes is the honest definition.
 */
const PERSON_PREFIXES = ['src/app/api/me/', 'src/app/api/account/', 'src/app/api/social/'];

function personRouteFiles(): string[] {
    return collectSourceFiles({ roots: ['src/app/api'], floor: 50 })
        .filter((f) => path.basename(f) === 'route.ts')
        .filter((f) => {
            const r = path.relative(ROOT, f).split(path.sep).join('/');
            return PERSON_PREFIXES.some((p) => r.startsWith(p));
        });
}

const rel = (f: string): string => path.relative(ROOT, f);
const codeOf = (f: string): string => blankNonCode(fs.readFileSync(f, 'utf8'));

describe('every person-scoped route uses getUserCtx', () => {
    it('rel() actually names the file — the failure message has teeth', () => {
        // `selector-teeth` found `rel()` dead and it was right: on the green
        // path `offenders` is empty, so `.map(rel)` is `[]` whatever `rel`
        // returns. Every assertion below would pass with `rel = () => ''`,
        // and a real failure would then list empty strings — naming nothing,
        // which is the one property these tests exist to provide.
        //
        // So `rel` is exercised directly on a known file. Not baselined as a
        // known-dead selector: the diagnostic IS the deliverable here, and
        // suppressing the finding would leave a guard that cannot tell you
        // which route broke.
        const sample = personRouteFiles()[0];

        expect(sample).toBeTruthy();
        expect(rel(sample)).toMatch(/^src\/app\/api\/(me|account|social)\//);
        expect(rel(sample)).not.toContain(ROOT);
        expect(rel(sample).endsWith('route.ts')).toBe(true);
    });

    it('reports the population it covers', () => {
        const files = personRouteFiles();
        const handlers = files.flatMap((f) =>
            (codeOf(f).match(/export const (GET|POST|PUT|PATCH|DELETE)\b/g) ?? []).map(
                (m) => `${rel(f)}#${m.split(' ').pop()}`,
            ),
        );
        // eslint-disable-next-line no-console -- the denominator IS the output
        console.log(
            `person-scoped route files: ${files.length}, handlers: ${handlers.length}\n  ` +
                handlers.join('\n  '),
        );

        expect(files.length).toBeGreaterThanOrEqual(6);
        expect(handlers.length).toBeGreaterThanOrEqual(10);
    });

    it('names any route that still authenticates with bare auth()', () => {
        const offenders = personRouteFiles().filter((f) => /\bawait auth\(\)/.test(codeOf(f)));

        expect(offenders.map(rel)).toEqual([]);
    });

    it('every person-scoped route calls getUserCtx', () => {
        // The positive half. "Does not call auth()" is satisfied by a route
        // that authenticates NOTHING, which is worse than the defect.
        const missing = personRouteFiles().filter((f) => !/getUserCtx\s*\(/.test(codeOf(f)));

        expect(missing.map(rel)).toEqual([]);
    });

    it('passes the REQUEST to getUserCtx, which is not decorative', () => {
        // `getUserCtx` reads `req.headers.get('authorization')` to refuse an
        // API key, and derives the person surface from `req.nextUrl.pathname`.
        // Called with no argument BOTH checks are skipped — the key refusal
        // silently, and the surface falling back to `account` by assumption
        // rather than derivation. Two handlers were `async () => {}` and had
        // to gain a parameter for this reason, so it is a real mistake to
        // make, not a hypothetical one.
        const bare: string[] = [];
        for (const f of personRouteFiles()) {
            if (/getUserCtx\s*\(\s*\)/.test(codeOf(f))) bare.push(rel(f));
        }

        expect(bare).toEqual([]);
    });

    it('the detector has teeth, on synthetic sources', () => {
        const BARE_AUTH = `export const GET = h(async (req) => {\n  const s = await auth();\n});`;
        const MIGRATED = `export const GET = h(async (req) => {\n  const ctx = await getUserCtx(req);\n});`;
        const COMMENT_ONLY = `export const GET = h(async (req) => {\n  // getUserCtx, not auth(), here\n  const ctx = await getUserCtx(req);\n});`;
        const NO_REQ = `export const GET = h(async () => {\n  const ctx = await getUserCtx();\n});`;
        const usesBareAuth = (s: string) => /\bawait auth\(\)/.test(blankNonCode(s));
        const callsNoArg = (s: string) => /getUserCtx\s*\(\s*\)/.test(blankNonCode(s));

        expect(usesBareAuth(BARE_AUTH)).toBe(true);
        expect(usesBareAuth(MIGRATED)).toBe(false);
        // The case that made the old assertions green for the wrong reason.
        expect(usesBareAuth(COMMENT_ONLY)).toBe(false);
        expect(callsNoArg(NO_REQ)).toBe(true);
        expect(callsNoArg(MIGRATED)).toBe(false);
    });
});
