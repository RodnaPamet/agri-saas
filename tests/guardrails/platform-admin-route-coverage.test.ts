/**
 * Every PLATFORM admin API route authenticates its caller — #2486.
 *
 * ## Why this is a separate guard and not a wider `BASE_DIR`
 *
 * `admin-route-coverage.test.ts` enforces the same property for the TENANT
 * tree, and its predicate is `requirePermission`. Platform routes authenticate
 * a MACHINE caller holding `PLATFORM_ADMIN_API_KEY`, so `requirePermission`
 * would never appear in them — pointing the existing guard at this tree would
 * fail all 21 for the wrong reason. The predicate is genuinely different,
 * which is what makes this a sibling rather than a widening.
 *
 * ## Nothing here is unguarded today, and that is the point
 *
 * Measured over all 22 `route.ts` files under `src/app/api/admin`: **21** call
 * `verifyPlatformApiKey`, **1** (`diagnostics`) gates on
 * `ctx.permissions.canAdmin` and throws `forbidden`, **0** are unguarded. So
 * this guard does not fix an exposure — it converts a property that held by
 * current practice into one that holds by a check. #2377's whole subject is
 * that an unchecked property stops holding without anyone noticing, and the
 * tree is platform-scoped: a key-rotation endpoint and a diagnostics endpoint
 * are among the 22.
 *
 * ## TWO accepted mechanisms, not one plus an allowlist
 *
 * `diagnostics` legitimately uses the permission check, and a one-file
 * allowlist is the kind of exemption that rots into cover for whatever lands
 * beside it. Naming both predicates and letting either satisfy the assertion
 * keeps the rule readable and leaves nothing to maintain.
 *
 * ## The two ways its sibling passed over nothing (#2485) are closed here
 *
 * `collectSourceFiles` throws when a root does not resolve and throws below its
 * floor, so a renamed tree is "this guard no longer knows where to look"
 * rather than "nothing to check" — and the population cannot quietly shrink to
 * a size that satisfies every assertion for free.
 *
 * Both predicates read code with comments BLANKED. A route that merely
 * mentions `verifyPlatformApiKey` in a docblock explaining why it does not
 * need one must not satisfy the check, which is the failure
 * `scan-roots-resolve`'s own detector was once caught by.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const PLATFORM_ADMIN_DIR = 'src/app/api/admin';

/** Measured 2026-10-30 at 22. A floor well below it absorbs ordinary churn. */
const ROUTE_FLOOR = 15;

const KEY_MODULE = '@/lib/auth/platform-admin';

/**
 * The machine-caller mechanism: a call to `verifyPlatformApiKey`, resolved
 * through its real module. The import is required as well as the call so a
 * same-named local helper cannot satisfy it.
 */
export function hasPlatformKeyGuard(code: string): boolean {
    return (
        /\bverifyPlatformApiKey\s*\(/.test(code)
        && new RegExp(`from\\s*['"]${KEY_MODULE.replace(/[/\\]/g, '\\$&')}['"]`).test(code)
    );
}

/**
 * The human-admin mechanism: read `canAdmin` off the resolved context AND
 * refuse. The refusal is part of the predicate because reading the flag and
 * ignoring it is not a guard.
 */
export function hasAdminPermissionGuard(code: string): boolean {
    return /permissions\s*\.\s*canAdmin/.test(code) && /\bforbidden\s*\(/.test(code);
}

export function guardMechanisms(code: string): string[] {
    const out: string[] = [];
    if (hasPlatformKeyGuard(code)) out.push('verifyPlatformApiKey');
    if (hasAdminPermissionGuard(code)) out.push('canAdmin+forbidden');
    return out;
}

interface Route {
    rel: string;
    mechanisms: string[];
}

function platformAdminRoutes(): Route[] {
    const files = collectSourceFiles({
        roots: [PLATFORM_ADMIN_DIR],
        extensions: ['.ts'],
        exclude: (rel) => !rel.endsWith(`${path.sep}route.ts`) && !rel.endsWith('/route.ts'),
        floor: ROUTE_FLOOR,
    });
    return files.map((abs) => ({
        rel: path.relative(REPO_ROOT, abs),
        mechanisms: guardMechanisms(blankNonCode(fs.readFileSync(abs, 'utf8'))),
    }));
}

const ROUTES = platformAdminRoutes();

describe('platform admin routes authenticate their caller (#2486)', () => {
    it('[platform-admin-coverage] ranges over a real set', () => {
        const byKey = ROUTES.filter((r) => r.mechanisms.includes('verifyPlatformApiKey')).length;
        const byPerm = ROUTES.filter((r) => r.mechanisms.includes('canAdmin+forbidden')).length;
        // Every line carries the tag: the step-summary reporter collects per
        // LINE, so an untagged continuation arrives truncated.
        console.log(`[platform-admin-coverage] ${ROUTES.length} route.ts under ${PLATFORM_ADMIN_DIR}`);
        console.log(`[platform-admin-coverage] verifyPlatformApiKey: ${byKey}`);
        console.log(`[platform-admin-coverage] canAdmin+forbidden  : ${byPerm}`);
        console.log(`[platform-admin-coverage] neither             : ${ROUTES.filter((r) => r.mechanisms.length === 0).length}`);

        // The floor is enforced inside collectSourceFiles, which throws; this
        // restates it so the denominator is visible in the test that reads it.
        expect(ROUTES.length).toBeGreaterThanOrEqual(ROUTE_FLOOR);
    });

    it.each(ROUTES.map((r) => [r.rel, r] as const))(
        '%s is guarded',
        (_rel, route) => {
            expect({ route: route.rel, guarded: route.mechanisms.length > 0 })
                .toEqual({ route: route.rel, guarded: true });
        },
    );

    it('a missing route tree FAILS rather than reporting nothing to check', () => {
        // The #2485 lesson as an executing control, not a promise in a
        // docblock: the collector refuses a root that does not resolve, so a
        // renamed tree cannot read as a clean run.
        expect(() =>
            collectSourceFiles({ roots: ['src/app/api/admin-renamed'], extensions: ['.ts'] }),
        ).toThrow(/scan root does not exist/);
    });

    it('a population below the floor FAILS rather than passing over nothing', () => {
        expect(() =>
            collectSourceFiles({
                roots: [PLATFORM_ADMIN_DIR],
                extensions: ['.ts'],
                exclude: () => true,
                floor: ROUTE_FLOOR,
            }),
        ).toThrow(/expected at least/);
    });

    it('both predicates have teeth, and neither is satisfied by prose', () => {
        // Synthetic rather than derived from the tree on purpose: if
        // `diagnostics` ever migrates to the key mechanism, a check that
        // asserted both mechanisms are REPRESENTED would start failing for a
        // reason unrelated to the property. These controls hold whatever the
        // tree looks like.
        const keyed = `import { verifyPlatformApiKey } from '${KEY_MODULE}';\nexport async function GET(req) { verifyPlatformApiKey(req); }`;
        const permed = `import { forbidden } from '@/lib/errors/types';\nexport async function GET() { if (!ctx.permissions.canAdmin) throw forbidden('no'); }`;
        const neither = `export async function GET() { return jsonResponse({ ok: true }); }`;

        expect(guardMechanisms(keyed)).toEqual(['verifyPlatformApiKey']);
        expect(guardMechanisms(permed)).toEqual(['canAdmin+forbidden']);
        expect(guardMechanisms(neither)).toEqual([]);

        // A call with no import does not count — a same-named local helper is
        // not the platform guard.
        expect(hasPlatformKeyGuard('function verifyPlatformApiKey(r) {}\nverifyPlatformApiKey(req);')).toBe(false);

        // Reading the flag without refusing is not a guard.
        expect(hasAdminPermissionGuard('const x = ctx.permissions.canAdmin;')).toBe(false);

        // And prose must not satisfy either predicate. This is the shape that
        // caught `scan-roots-resolve`'s own detector: a comment explaining why
        // a file is safe made it look safe.
        const prose = `/**\n * No verifyPlatformApiKey(req) here: this route is public by design,\n * and ctx.permissions.canAdmin / forbidden() do not apply.\n */\nexport async function GET() { return jsonResponse({}); }`;
        expect(guardMechanisms(blankNonCode(prose))).toEqual([]);
    });
});
