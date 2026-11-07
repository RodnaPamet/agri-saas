/**
 * The smart-nav route registries are a CLAIM ABOUT THE FILESYSTEM.
 *
 * `src/lib/nav/page-segregation.ts` (MAIN_PAGES / SUBPAGES /
 * BACK_AFFORDANCE_EXEMPT_SUBPAGES) and `src/lib/nav/canonical-parents.ts`
 * are hand-maintained lists of tenant-scoped route patterns. Nothing in
 * the type system connects them to `src/app/t/[tenantSlug]/(app)`, so a
 * deleted page leaves its entries behind indefinitely.
 *
 * The GRC teardown found 27 stale entries in page-segregation and 24 in
 * canonical-parents — /audits, /practices, /policies, /vendors, /clauses,
 * /findings, /mapping and their subtrees, all pointing at directories
 * that no longer exist. Every one had been dead since the deletion, and
 * every suite was green throughout.
 *
 * The failure is quiet rather than loud. `classifyRoute` answers from
 * these lists, so a stale entry does not crash — it just means the back
 * affordance and breadcrumb logic are reasoning about pages nobody can
 * reach. The inverse (a real page MISSING from the lists) is the bug
 * that actually bites users, and it has bitten twice already:
 * `/grain/payroll` and `/grain/calculator` were each added to the
 * sidebar without landing in MAIN_PAGES, leaving `classifyRoute`
 * answering 'unknown' for a route the sidebar linked to directly. That
 * direction is held for the Grain surfaces by
 * `tests/guards/grain-surface-nav-registration.test.ts`; this guard
 * holds the other direction, repo-wide.
 *
 * DIRECTION OF THIS GUARD: every registry entry must correspond to a
 * real page. It deliberately does NOT require the converse (every page
 * must be registered) — SUBPAGES is not meant to be exhaustive, and
 * `classifyRoute` has a legitimate 'unknown' answer.
 *
 * When you delete a route, delete its entries here in the same diff.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const APP = join(ROOT, 'src', 'app', 't', '[tenantSlug]', '(app)');

/**
 * Route patterns that resolve to something OTHER than a `page.tsx` —
 * e.g. a `route.ts` redirect shim. Empty today; add with a reason.
 */
const NON_PAGE_ROUTES: ReadonlyArray<{ route: string; reason: string }> = [];

/** Every tenant-scoped route pattern that has a real page on disk. */
function realRoutes(): Set<string> {
    const out = new Set<string>();
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (!statSync(full).isDirectory()) continue;
            if (existsSync(join(full, 'page.tsx'))) {
                out.add(full.slice(APP.length).split('\\').join('/') || '/');
            }
            walk(full);
        }
    };
    if (existsSync(join(APP, 'page.tsx'))) out.add('/');
    walk(APP);
    for (const e of NON_PAGE_ROUTES) out.add(e.route);
    return out;
}

/** Exported for the mutation proof. */
export function findDeadRoutes(
    declared: readonly string[],
    real: ReadonlySet<string>,
): string[] {
    return declared.filter((r) => !real.has(r));
}

function literalsIn(source: string, arrayName: string): string[] {
    const re = new RegExp(`\\b${arrayName}\\b[^=\\n]*=\\s*\\[(.*?)\\n\\]\\s*as const`, 's');
    const m = re.exec(source);
    if (!m) throw new Error(`could not locate ${arrayName} — has the file been restructured?`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('nav registries point at routes that exist', () => {
    const real = realRoutes();

    it('the route scan itself found a plausible tree', () => {
        // Guards the guard: a broken scan would make every list look
        // clean. (The first version of this diff had exactly that bug —
        // a sed prefix-strip that silently produced an empty set, which
        // reported all 27 live routes as dead.)
        expect(real.size).toBeGreaterThan(40);
        expect(real.has('/dashboard')).toBe(true);
        expect(real.has('/evidence')).toBe(true);
    });

    describe('page-segregation.ts', () => {
        const src = readFileSync(join(ROOT, 'src/lib/nav/page-segregation.ts'), 'utf8');
        /**
         * Per-list floors, measured 2026-11-07: MAIN_PAGES 20, SUBPAGES 32,
         * BACK_AFFORDANCE_EXEMPT_SUBPAGES 7. Set a little under each so an
         * ordinary deletion does not fail the guard while a broken extraction
         * does.
         */
        const FLOORS: Readonly<Record<string, number>> = {
            MAIN_PAGES: 15,
            SUBPAGES: 25,
            BACK_AFFORDANCE_EXEMPT_SUBPAGES: 5,
        };
        it.each(Object.keys(FLOORS))('%s has no entry for a deleted route', (name) => {
            const declared = literalsIn(src, name);

            // THE FLOOR, and it is what this assertion was missing.
            // `findDeadRoutes([], real)` returns `[]`, so an extraction that
            // produced NOTHING satisfied "no dead routes" perfectly —
            // `Selector teeth` reported `literalsIn` as SURVIVED when a PR
            // touching `src/lib/nav/` pulled this guard into the audit
            // population (#2844). An empty window passes a negated assertion,
            // which is why every extraction in this repo owes a denominator.
            //
            // The sibling `canonical-parents.ts` case below already had one
            // (`keys.length > 10`); this path simply never got it.
            expect(declared.length).toBeGreaterThanOrEqual(FLOORS[name]);
            // And every entry must LOOK like a route, so a regex that starts
            // matching the wrong thing fails too rather than returning a
            // plausible count of nonsense.
            for (const route of declared) expect(route.startsWith('/')).toBe(true);

            const dead = findDeadRoutes(declared, real);
            expect({ list: name, dead }).toEqual({ list: name, dead: [] });
        });
    });

    it('canonical-parents.ts has no entry for a deleted route', () => {
        const src = readFileSync(join(ROOT, 'src/lib/nav/canonical-parents.ts'), 'utf8');
        const keys = [...src.matchAll(/^\s*'(\/[^']*)':\s*\{/gm)].map((m) => m[1]);
        expect(keys.length).toBeGreaterThan(10);
        expect({ dead: findDeadRoutes(keys, real) }).toEqual({ dead: [] });
    });

    it('the non-page carve-out list carries a reason per entry', () => {
        for (const e of NON_PAGE_ROUTES) expect(e.reason.trim().length).toBeGreaterThan(10);
    });

    // ── Mutation proof ────────────────────────────────────────────────
    describe('the detector actually detects', () => {
        it('flags a route with no page on disk', () => {
            expect(findDeadRoutes(['/practices', '/dashboard'], new Set(['/dashboard']))).toEqual([
                '/practices',
            ]);
        });

        it('passes when every declared route is real', () => {
            expect(findDeadRoutes(['/dashboard'], new Set(['/dashboard', '/evidence']))).toEqual([]);
        });

        it('does not require the converse — extra real routes are fine', () => {
            // SUBPAGES is not exhaustive by design; 'unknown' is a valid
            // classifyRoute answer.
            expect(findDeadRoutes([], new Set(['/dashboard']))).toEqual([]);
        });
    });
});
