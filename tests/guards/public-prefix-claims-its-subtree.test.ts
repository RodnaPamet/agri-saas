/**
 * A fail-open PREFIX must actually claim a subtree — #1838.
 *
 * `PUBLIC_PATH_PREFIXES` is fail-open: a match skips the auth gate, and a
 * prefix claims everything beneath it. So an entry that serves exactly one
 * path is a loaded claim — the next route added under it is public by
 * inheritance, with nobody deciding. Nothing was reachable under any of the
 * seventeen entries #1838 narrowed, and that is precisely why it would have
 * gone unnoticed: an unauthenticated route looks exactly like a working one.
 *
 * ## The rule is WHERE the route sits, not how many there are
 *
 * "More than one route beneath it" is the obvious rule and it is wrong. `/f`
 * and `/api/integrations/webhooks/` serve exactly one route each and are
 * correctly prefixes, because that route sits under a dynamic segment
 * (`[handle]`, `[provider]`) — a subtree claim is what they mean. Meanwhile
 * `/api/admin/tenants` has a route AT the path and one beneath it, and needs
 * the subtree.
 *
 * So the question is: does a route sit AT the entry path, with none BENEATH
 * it? Then `PUBLIC_PATH_EXACT` is the precise claim and this fails. Derived
 * from the route tree rather than a list, so it stays true as routes are
 * added — which is the whole point, because the day someone adds a child
 * route under a single-path prefix is the day nobody is thinking about this
 * file.
 */
import * as path from 'node:path';

import { REPO_ROOT, collectSourceFiles } from '../helpers/collect-files';

import { PUBLIC_PATH_PREFIXES } from '@/lib/auth/guard';

/**
 * Entries that are prefixes for a reason the route tree cannot show, because
 * they have no route directory at all.
 */
const DOCUMENTED_SUBTREE_PREFIXES: Record<string, string> = {
    '/_next':
        'Framework internals. There is no `src/app/_next`, and `/_next/static/*` '
        + 'plus `/_next/image` must be reachable without a session or every page '
        + 'loads unstyled and scriptless.',
};

const ROUTE_FILES = ['route.ts', 'route.tsx', 'page.tsx'] as const;

/** Every served route path, as URL paths, derived from the route tree. */
function routePaths(): string[] {
    const files = collectSourceFiles({ roots: ['src/app'], floor: 500 });
    const appRoot = path.join(REPO_ROOT, 'src/app');
    const paths = files
        .filter((f) => ROUTE_FILES.some((name) => f.endsWith(`/${name}`)))
        .map((f) => {
            const rel = path.relative(appRoot, f);
            const dir = path.dirname(rel) === '.' ? '' : path.dirname(rel);
            // Route groups are invisible in the URL.
            return `/${dir}`.replace(/\([^)]*\)\/?/g, '').replace(/\/+/g, '/').replace(/\/$/, '');
        })
        .map((p) => (p === '' ? '/' : p));
    return [...new Set(paths)];
}

export type PrefixVerdict = 'subtree' | 'exact-is-precise' | 'no-routes';

/**
 * Where the routes under `entry` sit.
 *
 * Takes the route population so it can be handed a real entry that is NOT in
 * the swept list — which is how the controls below get a positive case
 * without inventing a route tree.
 */
export function classifyPrefix(entry: string, allRoutePaths: readonly string[]): PrefixVerdict {
    const base = entry.replace(/\/$/, '');
    const at = allRoutePaths.some((p) => p === base);
    const beneath = allRoutePaths.some((p) => p.startsWith(`${base}/`));
    if (beneath) return 'subtree';
    return at ? 'exact-is-precise' : 'no-routes';
}

describe('a fail-open prefix claims a subtree', () => {
    const paths = routePaths();

    it('no prefix entry serves exactly one path at its own address', () => {
        const misclaimed = PUBLIC_PATH_PREFIXES.filter(
            (entry) => classifyPrefix(entry, paths) === 'exact-is-precise',
        ).map((entry) => `${entry} — one route, AT the path; use PUBLIC_PATH_EXACT`);

        expect(misclaimed).toEqual([]);
    });

    it('every routeless prefix entry carries a written reason', () => {
        const unexplained = PUBLIC_PATH_PREFIXES.filter(
            (entry) =>
                classifyPrefix(entry, paths) === 'no-routes'
                && !DOCUMENTED_SUBTREE_PREFIXES[entry.replace(/\/$/, '')],
        );

        expect(unexplained).toEqual([]);
    });

    it('flags a single-path entry — using real paths that were narrowed out', () => {
        // The positive control, and it needs no synthetic tree: these four
        // moved to PUBLIC_PATH_EXACT in #1838 precisely because they are
        // single-path, so they are real routes the sweep above no longer
        // covers. If the classifier stopped discriminating, this fails.
        for (const moved of ['/api/livez', '/api/readyz', '/api/health', '/privacy']) {
            expect(classifyPrefix(moved, paths)).toBe('exact-is-precise');
            expect(PUBLIC_PATH_PREFIXES).not.toContain(moved);
        }
    });

    it('does NOT flag a one-route entry whose route is under a dynamic segment', () => {
        // The rule this guard would get wrong if it counted routes. Both
        // serve exactly one route and both are correctly prefixes.
        expect(classifyPrefix('/f', paths)).toBe('subtree');
        expect(classifyPrefix('/api/integrations/webhooks/', paths)).toBe('subtree');
    });

    it('swept a real route population and a real entry list', () => {
        expect(paths.length).toBeGreaterThanOrEqual(350);
        expect(PUBLIC_PATH_PREFIXES.length).toBeGreaterThanOrEqual(10);
        // Named, so a collapse of the path derivation cannot pass quietly.
        expect(paths).toContain('/f/[handle]');
        expect(paths).toContain('/api/readyz');
    });
});
