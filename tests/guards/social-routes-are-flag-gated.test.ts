import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/**
 * Every social route is behind a runtime feature flag.
 *
 * ── the hard part is that there are ZERO social routes today ──
 *
 * This guard ships in P0.4, before the surfaces it governs exist. A sweep over
 * an empty population passes trivially, so the guard would be green and worth
 * nothing — and would STAY green when the first ungated social route lands,
 * because nobody would notice that the thing it protects had never been
 * exercised. That is the failure this file is written around.
 *
 * So it asserts three different things:
 *
 *   1. the DETECTOR works, proved against inline fixtures — an ungated source is
 *      flagged and a gated one is not. This has teeth on day one, with no social
 *      routes in the tree.
 *   2. the WALK works, proved by pointing it at a directory that does contain
 *      routes and getting a non-empty answer. A walk that silently returns
 *      nothing is how an empty population becomes invisible.
 *   3. the real sweep over the social directories, which is empty today and
 *      becomes load-bearing the moment one of them gets a file.
 *
 * Assertion 3 alone would be a guard that cannot fail. 1 and 2 are what make it
 * a guard rather than a placeholder.
 */

/**
 * Where social surfaces will live. Listed rather than inferred: a prefix like
 * `src/app/api` would pull in every existing route and make this guard about
 * the whole API.
 */
const SOCIAL_API_DIRS = [
    'src/app/api/social',
    'src/app/api/me',
];

/** The gate a social route must call. */
const GATE = /assertFeatureEnabled|isFeatureEnabled|requireFeature/;

/** Source with comments stripped, so prose about the gate cannot satisfy it. */
function codeOf(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Every API `route.ts`, via the house collector.
 *
 * NOT a hand-rolled walk, and that is the point of using it: a bespoke walk can
 * be gutted to return `[]` with every assertion built on it still green —
 * measured at 81% of the guards an automated sweep could audit
 * (tests/guards/file-collection-is-not-silently-empty.test.ts). `collectSourceFiles`
 * throws on a missing root and refuses a result below its floor.
 *
 * The floor is on the WHOLE API population, which is large and known. The social
 * subset is then a filter over a guarded base, so "zero social routes" is a
 * legitimate filter result rather than an unnoticed broken walk.
 */
function allApiRouteFiles(): string[] {
    return collectSourceFiles({
        roots: ['src/app/api'],
        exclude: (rel) => !rel.endsWith('/route.ts'),
        // ~369 route files today. A floor well under that still catches an
        // exclude predicate that ate the population, without breaking on growth.
        floor: 200,
    }).map((abs) => path.relative(REPO_ROOT, abs));
}

const isSocialPath = (rel: string): boolean =>
    SOCIAL_API_DIRS.some((d) => rel.startsWith(`${d}/`));

const isGated = (src: string): boolean => GATE.test(codeOf(src));

describe('the detector has teeth before any social route exists', () => {
    const UNGATED = `
        export const GET = withApiErrorHandling(async () => {
            return jsonResponse({ posts: [] });
        });
    `;
    const GATED = `
        export const GET = withApiErrorHandling(async () => {
            await assertFeatureEnabled('social.feed', ctx.userId);
            return jsonResponse({ posts: [] });
        });
    `;
    const GATED_IN_PROSE_ONLY = `
        // This route will call assertFeatureEnabled once the flag exists.
        export const GET = withApiErrorHandling(async () => {
            return jsonResponse({ posts: [] });
        });
    `;

    it('flags an ungated route', () => {
        expect(isGated(UNGATED)).toBe(false);
    });

    it('accepts a gated route', () => {
        expect(isGated(GATED)).toBe(true);
    });

    it('is NOT satisfied by a comment promising the gate', () => {
        // The failure mode that has bitten this repo repeatedly: a text guard
        // matching the prose ABOUT the thing rather than the thing. Masking at
        // the read seam is what makes the difference.
        expect(isGated(GATED_IN_PROSE_ONLY)).toBe(false);
    });
});

describe('the collector is guarded, so an empty social set means empty and not broken', () => {
    it('POSITIVE CONTROL: the API population is large and real', () => {
        // If this ever returned a handful, the filter below would report zero
        // social routes for the wrong reason. The collector throws rather than
        // returning a short list, so this is belt and braces on its floor.
        const all = allApiRouteFiles();
        expect(all.length).toBeGreaterThan(200);
        expect(all).toContain('src/app/api/auth/me/route.ts');
    });

    it('the social filter actually selects — proved on a synthetic path', () => {
        // Without this, `isSocialPath` could return false for everything and the
        // sweep would be empty forever, including after social routes land.
        expect(isSocialPath('src/app/api/social/feed/route.ts')).toBe(true);
        expect(isSocialPath('src/app/api/me/flags/route.ts')).toBe(true);
        expect(isSocialPath('src/app/api/auth/me/route.ts')).toBe(false);
    });
});

describe('every social route is flag-gated', () => {
    const social = allApiRouteFiles().filter(isSocialPath);

    it('reports the population it is covering', () => {
        // Printed rather than implied: a reader of a green run should be able to
        // see whether this swept 0 files or 40. The count is 0 today by design.
        console.log(`social route files swept: ${social.length} (${SOCIAL_API_DIRS.join(', ')})`);
        expect(Array.isArray(social)).toBe(true);
    });

    it.each(social.length ? social : [['__none_yet__']].flat())(
        '%s calls the feature gate',
        (rel) => {
            if (rel === '__none_yet__') {
                // No social routes exist yet. The detector and walk above are
                // what carry this file's weight until one does.
                expect(social).toEqual([]);
                return;
            }
            expect(isGated(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))).toBe(true);
        },
    );
});
