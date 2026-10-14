/**
 * Every tenant-relative path a client READS must resolve to a route that
 * exists.
 *
 * ## The defect this exists for
 *
 * The #1740 treatment form read `/catalog/items?category=PESTICIDE,FERTILIZER`
 * and `/catalog/units?measure=RATE`. There is no `/catalog` API in this
 * repository at all — those two lines were its only mentions anywhere. The
 * real routes are `/items` and `/units`.
 *
 * A farmer would have opened «Нов запис» to an empty product picker and an
 * empty unit picker, with step one impossible to complete because both are
 * required. The feature was unusable, and ten rendered tests were green: they
 * mock `useTenantSWR` BY KEY, so the double answered a key the server never
 * serves. CI's E2E caught it three pushes later, by timing out on an option
 * that could never appear.
 *
 * Nothing else would have. A typo'd path is not a type error, SWR reports a
 * 404 the same way it reports an empty list to a component that tolerates
 * both, and the mock stood between the test and the truth.
 *
 * ## What is checked, and the denominator
 *
 * Literal first arguments to `useTenantSWR(...)` under `src/`, with the query
 * string stripped. Each must map to a `route.ts` under
 * `src/app/api/t/[tenantSlug]/`, matching a literal segment exactly or a
 * dynamic one (`[id]`) for any single segment.
 *
 * Both populations come from `tests/helpers/collect-files.ts`, which refuses
 * an empty result, and the test PRINTS how many paths it resolved and how many
 * it skipped — because a scanner that silently finds nothing passes. Skipped means a non-literal
 * key — `` `/journal/${id}` `` or a variable — which this cannot resolve
 * without evaluating the expression; those are reported, not hidden, so a
 * refactor that turns every call into a template literal shows up as the
 * coverage collapsing rather than as a green run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const ROOT = REPO_ROOT;
const API_ROOT = 'src/app/api/t/[tenantSlug]';

/**
 * Both populations come from `collectSourceFiles`, which refuses an empty
 * result — required by `file-collection-is-not-silently-empty`, and for the
 * reason it gives: a collector written by hand here can be gutted to return
 * nothing with every assertion below still green, measured across 81% of the
 * guards an automated sweep could audit. This guard's first version walked
 * the tree itself and that meta-guard failed it on CI, which is the system
 * working.
 *
 * The route scan passes `extensions: ['route.ts']` — the helper matches by
 * SUFFIX, so a filename works where an extension is expected.
 */
function routeSegments(): string[][] {
    // No label option: `CollectOptions` is roots / extensions / skipDirs /
    // exclude / floor / expectEmptyBecause, and the helper builds its own
    // failure label from the roots. I passed `what:` and it is an excess
    // property — TS2353, caught by CI's Typecheck and NOT by this file's own
    // jest run, because the node project's ts-jest does not reject it.
    return collectSourceFiles({
        roots: [API_ROOT],
        extensions: ['route.ts'],
        floor: 100,
    }).map((abs) =>
        path
            .relative(path.join(ROOT, API_ROOT), abs)
            .split(path.sep)
            .slice(0, -1), // drop the `route.ts` filename
    );
}

/** Does a client path match a route, treating `[x]` as one wildcard segment? */
function resolves(clientPath: string, routes: string[][]): boolean {
    const want = clientPath.split('/').filter(Boolean);
    return routes.some(
        (route) =>
            route.length === want.length &&
            route.every((seg, i) => (seg.startsWith('[') ? true : seg === want[i])),
    );
}

interface Found {
    file: string;
    raw: string;
}

/** Literal `useTenantSWR('…')` first arguments, comments blanked. */
function scanClientPaths(): { literal: Found[]; skipped: Found[] } {
    const literal: Found[] = [];
    const skipped: Found[] = [];
    for (const full of collectSourceFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        floor: 500,
    })) {
        // COMMENTS BLANKED FIRST, via the shared helper. `useTenantSWR`'s own
        // docblock shows `useTenantSWR<…>('/practices')` as its usage example,
        // and this guard's first run reported that prose as an unresolved
        // path — a scar read as a wound.
        const src = blankNonCode(fs.readFileSync(full, 'utf8'));
        if (!src.includes('useTenantSWR')) continue;
        const rel = path.relative(ROOT, full);
        for (const m of src.matchAll(/useTenantSWR\s*(?:<[^>]*>)?\s*\(\s*([^,)]*)/g)) {
            const arg = m[1].trim();
            // `open ? '/items' : null` — take the literal inside a ternary,
            // which is how every conditional read here is written. Without
            // this the commonest shape in the codebase would be skipped and
            // the guard would cover almost nothing while passing.
            const lit = /'(\/[^']*)'/.exec(arg);
            if (lit && !arg.includes('${')) literal.push({ file: rel, raw: lit[1] });
            else skipped.push({ file: rel, raw: arg.slice(0, 60) });
        }
    }
    return { literal, skipped };
}

describe('client SWR paths resolve to real API routes', () => {
    const routes = routeSegments();
    const { literal, skipped } = scanClientPaths();

    it('resolved a meaningful number of routes and paths', () => {
        // Anti-vacuity on BOTH axes: a broken API scan makes every path fail,
        // and a broken path scan makes the suite pass with nothing checked.
        // eslint-disable-next-line no-console
        console.log(
            `[swr-paths-resolve] ${routes.length} tenant routes; ` +
                `${literal.length} literal client paths checked; ${skipped.length} non-literal skipped`,
        );
        expect(routes.length).toBeGreaterThan(100);
        expect(literal.length).toBeGreaterThan(20);
    });

    it('every literal path names a route that exists', () => {
        const unresolved = literal
            .filter((f) => !resolves(f.raw.split('?')[0], routes))
            .map((f) => `  ${f.file}: ${f.raw}`);
        expect(unresolved.join('\n')).toBe('');
    });

    it('the matcher can FAIL — a path nobody serves does not resolve', () => {
        // The positive control. `/catalog/items` is the exact path that
        // shipped and broke the treatment form; if this ever resolves, the
        // matcher has become a tautology and the assertion above is theatre.
        expect(resolves('/catalog/items', routes)).toBe(false);
        expect(resolves('/items', routes)).toBe(true);
        // A dynamic segment matches one segment, not two.
        expect(resolves('/journal/some-id', routes)).toBe(true);
        expect(resolves('/journal/some-id/and/more', routes)).toBe(false);
    });

    it('ignores paths that appear only in PROSE', () => {
        // `use-tenant-swr.ts` documents itself with `useTenantSWR('/practices')`
        // in a docblock, and there is no `/practices` route — so without
        // blanking comments this guard reports the hook's own documentation as
        // a defect. It did, on its first run. The scan must therefore see
        // nothing in a commented call.
        const commented = blankNonCode(`
            /** Example: useTenantSWR<Thing[]>('/nowhere-at-all'); */
            // useTenantSWR('/also-nowhere');
            const x = 1;
        `);
        expect(commented).not.toContain('nowhere-at-all');
        expect(commented).not.toContain('also-nowhere');
        // And the inverse, so this is not passing because the helper blanks
        // everything: real code survives.
        expect(blankNonCode("const k = useTenantSWR('/items');")).toContain("'/items'");
    });
});
