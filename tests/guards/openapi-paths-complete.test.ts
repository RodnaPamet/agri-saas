/**
 * Every API route on disk is described, exempt, or on a shrinking baseline.
 *
 * ## Why this file exists
 *
 * Two source files asserted, by name, that it already did:
 *
 *   src/lib/openapi/paths/helpers.ts:20
 *     "a guard (`tests/guards/openapi-paths-complete.test.ts`) that compares
 *      the registered paths against the route files on disk, so a route
 *      without a spec fails CI rather than going quietly undocumented"
 *
 *   src/lib/openapi/paths/index.ts:7
 *     "the completeness guard ... fails for any route file on disk that no
 *      module documents, so a new route cannot go quietly undescribed"
 *
 * It did not exist. Measured 2026-09-17: adding a brand-new route file with two
 * handler methods and no spec entry left all 153 openapi tests green, and the
 * four other route-walking guardrails green too (169 of 169). The prose was the
 * only thing standing between a new route and going undescribed, and prose does
 * not fail a build.
 *
 * That is the same defect the spec itself had — `paths?:` typed optional, so a
 * document describing ZERO endpoints satisfied every check — one level up. A
 * claim about enforcement is not enforcement.
 *
 * ## What it checks
 *
 * The route list is DERIVED from the filesystem, never hardcoded, so a new
 * route is covered the moment it exists rather than when someone remembers to
 * register it here.
 *
 *   1. positive controls — the walk found routes, the spec parsed, and every
 *      REGISTERED path maps back to a real file. Without the third, a mapper
 *      that produced garbage would report every route as undocumented and the
 *      baseline would absorb it silently.
 *   2. every route file is registered, exempt, or baselined — a new one that is
 *      none of those fails.
 *   3. no stale baseline entries — one that is now registered, or whose file is
 *      gone, fails with instructions to delete it.
 *   4. a REGISTERED path documents every method its file exports. This is
 *      strict from day one because it already holds: 0 of 26 registered paths
 *      omit a method today, so there is no debt to grandfather.
 *   5. the baseline only shrinks.
 *
 * ## The mapping
 *
 * `src/app/api/t/[tenantSlug]/journal/[id]/route.ts`
 *   -> `/api/t/{tenantSlug}/journal/{id}`
 *
 * Strip `src/app`, strip `/route.ts`, turn `[x]` into `{x}`. Verified in the
 * reverse direction by control 1: all 26 registered paths resolve to a file
 * that exists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    API_REL,
    NON_SURFACE_ROUTE_FILES as EXEMPT_ROUTE_FILES,
    ROOT,
    routeFiles,
    toOpenApiPath,
    toRouteFile,
} from '../../scripts/lib/api-routes';

const SPEC_PATH = path.join(ROOT, 'src/generated/openapi.json');
const BASELINE_PATH = path.join(__dirname, 'openapi-undocumented-baseline.json');

/**
 * Not describable by this mapping, as opposed to merely undescribed.
 *
 * NextAuth's catch-all serves a whole family of endpoints (`/signin`,
 * `/callback/:provider`, `/csrf`, …) from one file, so it has no single path
 * template. Baselining it would imply someone should eventually write one entry
 * for it; exempting it says the mapping does not reach it.
 *
 * Imported as `NON_SURFACE_ROUTE_FILES` from `scripts/lib/api-routes`, which
 * holds the route derivation once — the inventory generator needs the same
 * exclusion, and two copies of it is how the two answers drift.
 */

/** The HTTP verbs Next.js treats as route handlers. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Lowered in the same diff that removes entries. See the baseline's _README. */
// 313 -> 309: the four dashboard/briefing routes are described now
// (`dashboard.paths.ts`), so they leave the baseline in the same diff that
// documents them — which is what this guard's sibling assertion demands.
// 239 -> 241: the two platform flag-console routes (P0.4). Baselined rather
// than described, matching every other `/api/admin/*` platform-key route — the
// consumer is an operator holding `PLATFORM_ADMIN_API_KEY`, not a client that
// reads the spec. All twelve non-tenant /api/admin paths are baselined, these
// two included, so describing only these would make the spec's coverage of that
// surface harder to reason about, not easier.
// Raising this is the visible line the guard's own error message asks for.
// 241 -> 242: the platform master-KEK rotation sweep. Baselined like every
// other non-tenant /api/admin path — the consumer is an operator mid-rotation
// with curl, not a client reading the spec.
// 242 -> 243: the misplaced-v2 repair. Baselined like every other non-tenant
// /api/admin path — an operator mid-migration with curl, not a spec reader.
// 244 -> 243: `/api/account/avatar/{userId}` is DESCRIBED now
// (`account.paths.ts`, #1299), so it leaves the baseline in the same diff that
// documents it — the direction this guard's sibling assertion demands. It was
// the one path on this list a native client was already calling: iOS was
// reading its shape out of route code (agrent-ios#149).
// 243 → 246 (P3.9): the three `/api/admin/farm-claims` routes — the staff
// verification queue and its verify/dispute actions.
//
// Baselined rather than described, consistent with all 51 other
// `/api/admin/*` paths already here, and for a reason worth stating rather
// than inheriting: `src/generated/openapi.json` is the CLIENT-facing contract,
// and enumerating the platform-admin surface in it would advertise every
// operator endpoint to every consumer of the spec. These are documented where
// an operator will actually look — their own docblocks and
// `farm-identity-review.ts`.
//
// The contrast is #1341's `/api/public/eik-check`, which got a real OpenAPI
// module: that one is unauthenticated and third parties may call it, so
// leaving it undescribed would have been the wrong trade in the other
// direction. "Baseline or describe" is a question about the AUDIENCE, not a
// uniform rule.
const UNDOCUMENTED_CEILING = 218;
// Lowered 246 -> 245 by #1376: `/api/auth/register` was retired, so its
// baseline entry went with it. The ceiling tracks the baseline exactly —
// leaving slack is how a shrink-only ratchet quietly becomes a denylist with
// room for one more.

interface Baseline {
    _README: string[];
    undocumented: string[];
}

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as {
    paths?: Record<string, Record<string, unknown>>;
};
const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline;




/**
 * The verbs a route file exports.
 *
 * Text-matched rather than parsed, and control 1b is what makes that safe: if
 * this pattern missed a spelling, some file would report zero methods, and no
 * file legitimately exports none.
 */
function methodsExported(routeFile: string): string[] {
    const src = fs.readFileSync(path.join(ROOT, routeFile), 'utf8');
    return METHODS.filter((m) =>
        new RegExp(String.raw`export\s+(?:async\s+)?(?:const|function)\s+${m}\b`).test(src),
    );
}

const FILES = routeFiles();
const REGISTERED = new Set(Object.keys(spec.paths ?? {}));
const BASELINED = new Set(baseline.undocumented);

describe('every API route is described, exempt, or on a shrinking baseline', () => {
    describe('the guard is reading a real tree and a real spec', () => {
        it('the filesystem walk found route files', () => {
            // Without this, a renamed API directory makes every assertion below
            // pass over an empty set — the empty-selection defect this repo
            // keeps finding.
            expect(FILES.length).toBeGreaterThan(300);
        });

        it('the spec parsed and describes endpoints', () => {
            expect(REGISTERED.size).toBeGreaterThan(0);
        });

        it('every route file exports at least one HTTP method', () => {
            // Control on `methodsExported`. A file reporting zero would mean the
            // pattern is wrong, not that the route is empty.
            //
            // Asserted as a POSITIVE TOTAL, not as an absence of zeros. The
            // first version of this was `FILES.filter((f) => methodsExported(f)
            // .length === 0)` and `selector-teeth` killed it: gutting
            // `methodsExported` to `new Set()` leaves `.length` UNDEFINED,
            // `undefined === 0` is false, so nothing was flagged and the
            // control reported every file healthy while the function returned
            // nothing at all. Summing makes the same gut produce NaN, and
            // `NaN > 400` is false — so the hole fails instead of passing.
            const counts = FILES.map((f) => methodsExported(f).length);
            const total = counts.reduce((a, b) => a + b, 0);
            expect(total).toBeGreaterThan(400); // 498 today
            expect(counts.filter((n) => !(n > 0))).toEqual([]);
        });

        it('every REGISTERED path maps back to a route file that exists', () => {
            // Control on the mapper, in the direction the baseline cannot hide.
            // A broken mapping would report all 353 routes undocumented; this
            // fails first and says so.
            const orphaned = [...REGISTERED].filter(
                (p) => !fs.existsSync(path.join(ROOT, toRouteFile(p))),
            );
            expect(orphaned).toEqual([]);
        });
    });

    describe('completeness', () => {
        it('no route file is undocumented without being baselined', () => {
            const unaccounted = FILES.filter(
                (f) => !EXEMPT_ROUTE_FILES.has(f) && !REGISTERED.has(toOpenApiPath(f)) && !BASELINED.has(toOpenApiPath(f)),
            );
            if (unaccounted.length > 0) {
                throw new Error(
                    `${unaccounted.length} API route(s) are neither described in ` +
                        `src/generated/openapi.json nor listed in ` +
                        `tests/guards/openapi-undocumented-baseline.json:\n` +
                        unaccounted.map((f) => `  ${f}  ->  ${toOpenApiPath(f)}`).join('\n') +
                        `\n\nDescribe it in the matching src/lib/openapi/paths/*.paths.ts module, ` +
                        `or add its path to the baseline AND raise UNDOCUMENTED_CEILING in this ` +
                        `file — which is a visible line in your diff, deliberately.`,
                );
            }
            expect(unaccounted).toEqual([]);
        });

        it('a REGISTERED path documents every method its route file exports', () => {
            const gaps: string[] = [];
            for (const p of REGISTERED) {
                const file = toRouteFile(p);
                if (!fs.existsSync(path.join(ROOT, file))) continue; // control 1d owns this
                const documented = new Set(Object.keys(spec.paths?.[p] ?? {}).map((m) => m.toUpperCase()));
                for (const m of methodsExported(file)) {
                    if (!documented.has(m)) gaps.push(`${p} exports ${m}, spec does not describe it`);
                }
            }
            // Strict from day one: 0 of 26 registered paths omit a method today,
            // so there is no existing debt this would have to grandfather.
            expect(gaps).toEqual([]);
        });
    });

    describe('the baseline cannot rot', () => {
        it('no baselined path is already described', () => {
            const stale = baseline.undocumented.filter((p) => REGISTERED.has(p));
            if (stale.length > 0) {
                throw new Error(
                    `${stale.length} baseline entr(ies) are now described in the spec. ` +
                        `Delete them from tests/guards/openapi-undocumented-baseline.json and ` +
                        `lower UNDOCUMENTED_CEILING to ${baseline.undocumented.length - stale.length} ` +
                        `in the same diff:\n` +
                        stale.map((p) => `  ${p}`).join('\n'),
                );
            }
            expect(stale).toEqual([]);
        });

        it('no baselined path points at a route file that no longer exists', () => {
            const orphaned = baseline.undocumented.filter(
                (p) => !fs.existsSync(path.join(ROOT, toRouteFile(p))),
            );
            if (orphaned.length > 0) {
                throw new Error(
                    `${orphaned.length} baseline entr(ies) name a route that was deleted or ` +
                        `moved. Remove them and lower UNDOCUMENTED_CEILING accordingly:\n` +
                        orphaned.map((p) => `  ${p}`).join('\n'),
                );
            }
            expect(orphaned).toEqual([]);
        });

        it('the baseline only shrinks', () => {
            expect(baseline.undocumented.length).toBeLessThanOrEqual(UNDOCUMENTED_CEILING);
        });

        it('the ceiling tracks the baseline rather than floating above it', () => {
            // Slack here would let entries be added silently up to the gap, which
            // is how an upward ratchet quietly becomes a denylist.
            expect(UNDOCUMENTED_CEILING).toBe(baseline.undocumented.length);
        });

        it('every baselined path is unique', () => {
            expect(new Set(baseline.undocumented).size).toBe(baseline.undocumented.length);
        });
    });

    describe('the exemption is real', () => {
        it('every exempt route file exists', () => {
            // An exemption for a file that is gone is an exemption nobody can
            // evaluate, and it would sit here forever.
            for (const f of EXEMPT_ROUTE_FILES) {
                expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
            }
        });
    });
});
