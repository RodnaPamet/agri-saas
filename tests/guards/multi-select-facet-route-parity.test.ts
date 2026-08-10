/**
 * A `multiple: true` facet needs a route that can read a comma-joined param.
 *
 * `filterStateToUrlParams` joins a multi-select facet's values into ONE query
 * param: two selected statuses arrive as `?status=DRAFT,APPROVED`. What the
 * receiving route does with that decides which of two failures the user gets:
 *
 *   - `z.enum([...])` REJECTS the joined value → 400. Loud, at least.
 *   - `z.string()` ACCEPTS it, and the literal `"DRAFT,APPROVED"` reaches
 *     Prisma as an equality, matching nothing. The list page renders its EMPTY
 *     state: a confident "no evidence matches your filters" in response to a
 *     filter that never ran. A wrong answer that looks like an answer, which
 *     is the worse of the two and the reason this guard exists.
 *
 * The audit that produced the backlog below found **36** multi-select facets
 * across 14 list pages, of which two were parsed correctly. This is a
 * widespread bug class, not a one-page slip, so the guard inventories all of
 * them: a facet is either CSV-parsed, or listed in `KNOWN_UNFIXED` with a
 * reason. A NEW multi-select facet on a route that reads it as a scalar fails
 * CI, and every entry deleted from the backlog is a page fixed.
 *
 * Fix shape (see the evidence route for the reference implementation):
 *   1. `csvEnumField(z.enum([...]))` / `csvIdField()` in the route's schema.
 *   2. The usecase + repository filter field typed as an ARRAY, never
 *      `string` plus a cast.
 *   3. `{ field: { in: [...] } }` guarded on `.length` — an empty array must
 *      OMIT the filter, because `{ in: [] }` matches nothing and would empty
 *      the table when a user CLEARS a facet.
 *
 * ── Route resolution (read this before adding a new exclusion) ──
 *
 * A page's facets are declared once, in `.../<page>/filter-defs.ts`. Its API
 * surface is NOT always a `route.ts` sitting directly beside that page — it
 * is often a sub-resource collection (`.../planning/crop-plans/route.ts`,
 * `.../exchange/listings/route.ts`). This guard used to check only the
 * literal sibling path and silently PASS (no assertion at all) when that
 * exact file was missing — which is exactly how the crop-plans defect (the
 * comma-joined `status` facet 500ing `GET /planning/crop-plans`) went
 * undetected: `planning` was hard-excluded via `NO_SIBLING_ROUTE` instead of
 * resolved. `findRouteFiles` now walks the WHOLE subtree under a page's API
 * directory, so a route nested one or more levels down is found wherever it
 * lives. A page whose API directory doesn't exist at all (or exists but none
 * of its nested routes parse the key) still requires an explicit entry in
 * `NO_SIBLING_ROUTE` or `KNOWN_UNFIXED` — there is no silent skip left.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const PAGES = join(ROOT, 'src/app/t/[tenantSlug]/(app)');
const API = join(ROOT, 'src/app/api/t/[tenantSlug]');

/**
 * Facets whose route still reads the param as a scalar.
 *
 * Every entry is a live defect: selecting two values on that facet either
 * 400s or silently returns nothing. They are listed rather than fixed because
 * each needs its own route + usecase + repository change, and shipping 34 of
 * those in one diff would make the change unreviewable. Delete an entry when
 * you fix its page — the "no stale entries" test below fails if you forget.
 */
const KNOWN_UNFIXED: Readonly<Record<string, readonly string[]>> = {};

/**
 * Pages whose facets are handled by an API route the directory walk below
 * genuinely cannot reach — a name MISMATCH, not a nesting depth the walk
 * already handles.
 *
 *   - `grain/yield` — the page directory is `grain/yield`, but its route
 *     lives at the DIFFERENTLY-NAMED sibling `grain/yield-records/`, not
 *     nested under `grain/yield/` at all. `findRouteFiles(API/grain/yield)`
 *     finds nothing because that directory doesn't exist; only a
 *     page-name → route-name alias map would bridge it, which is more
 *     machinery than one documented exception is worth. Verified by hand:
 *     `seasonId` / `locationId` / `commodity` are each `parseCsvIdParam`'d
 *     in `grain/yield-records/route.ts`.
 *
 * `exchange` and `planning` used to live here too — both are genuinely
 * NESTED under their page directory (`exchange/listings/route.ts`,
 * `planning/crop-plans/route.ts`), so the recursive walk resolves them for
 * real now. `tests` was dropped as stale: the compliance "control
 * exoskeleton" page it referred to was deleted in #501 and no longer has a
 * `filter-defs.ts`, so the entry no longer matched anything.
 */
const NO_SIBLING_ROUTE = new Set(['grain/yield']);

function findFilterDefs(dir: string, prefix = ''): Array<{ page: string; file: string }> {
    const out: Array<{ page: string; file: string }> = [];
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...findFilterDefs(full, prefix ? `${prefix}/${entry}` : entry));
        } else if (entry === 'filter-defs.ts') {
            out.push({ page: prefix, file: full });
        }
    }
    return out;
}

/** Facet keys declared with `multiple: true`. */
function multiSelectKeys(source: string): string[] {
    const keys = new Set<string>();
    for (const m of source.matchAll(/\n(\s+)(\w+):\s*\{([\s\S]*?)\n\1\},/g)) {
        if (m[3].includes('multiple: true')) keys.add(m[2]);
    }
    return [...keys].sort();
}

/**
 * Every `route.ts` nested ANYWHERE under `dir`, at any depth — not just a
 * direct child. Returns `[]` when `dir` doesn't exist, which lets callers
 * treat "no matching API directory at all" the same as "found some routes,
 * none of which parse this key": both require an explicit
 * `NO_SIBLING_ROUTE` / `KNOWN_UNFIXED` entry rather than a silent pass.
 */
function findRouteFiles(dir: string): string[] {
    const out: string[] = [];
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...findRouteFiles(full));
        } else if (entry === 'route.ts') {
            out.push(full);
        }
    }
    return out;
}

/** True when the route parses `key` as a comma-joined list. */
function parsesCsv(routeSource: string, key: string): boolean {
    // EVERY occurrence, not just the first. A route file often declares the
    // same field name in more than one schema — farm-tasks has
    // `assigneeUserId` in its POST body schema ABOVE the query schema — and
    // matching only the first occurrence reported a correctly-migrated facet
    // as unparsed.
    for (const m of routeSource.matchAll(new RegExp(`\\n\\s*${key}:\\s*([^\\n]*)`, 'g'))) {
        if (/csvEnumField|csvIdField/.test(m[1])) return true;
    }
    // The imperative helpers are equally valid.
    return new RegExp(`parseCsv(Enum|Id)Param\\(\\s*[^)]*${key}`).test(routeSource);
}

/** True when ANY route file nested under the page's API directory parses `key`. */
function facetIsCsvParsed(page: string, key: string): boolean {
    return findRouteFiles(join(API, page)).some((f) => parsesCsv(readFileSync(f, 'utf8'), key));
}

const DEFS = findFilterDefs(PAGES);

describe('multi-select facet ↔ route parity', () => {
    it('found the filter-defs files (self-check)', () => {
        // A broken walker would make every assertion below vacuous.
        expect(DEFS.length).toBeGreaterThan(5);
        expect(DEFS.some((d) => d.page === 'evidence')).toBe(true);
    });

    const cases = DEFS.flatMap(({ page, file }) =>
        multiSelectKeys(readFileSync(file, 'utf8')).map((key) => ({ page, key })),
    );

    it('found multi-select facets to check (self-check)', () => {
        expect(cases.length).toBeGreaterThan(10);
    });

    it.each(cases)('$page.$key is CSV-parsed or on the backlog', ({ page, key }) => {
        if (NO_SIBLING_ROUTE.has(page)) return;
        if (facetIsCsvParsed(page, key)) return;

        // Not parsed — it must be an acknowledged, documented offender.
        expect(KNOWN_UNFIXED[page] ?? []).toContain(key);
    });

    it('the backlog has no stale entries', () => {
        // An entry that is now CSV-parsed must be deleted in the same diff
        // that fixed it, or the list stops describing reality.
        const stale: string[] = [];
        for (const [page, keys] of Object.entries(KNOWN_UNFIXED)) {
            for (const key of keys) {
                if (facetIsCsvParsed(page, key)) stale.push(`${page}.${key} is fixed — remove it from KNOWN_UNFIXED`);
            }
        }
        expect(stale).toEqual([]);
    });

    it('the NO_SIBLING_ROUTE backlog has no stale entries', () => {
        // Same discipline as KNOWN_UNFIXED, for the other exclusion list:
        // a page dropped from the app (its filter-defs.ts deleted, e.g.
        // `tests`) or a page whose route the walker can now resolve for
        // real (e.g. `exchange`, `planning`) must be removed here too, or
        // this guard is back to being blind about it.
        const stale: string[] = [];
        for (const page of NO_SIBLING_ROUTE) {
            const keys = cases.filter((c) => c.page === page).map((c) => c.key);
            if (keys.length === 0) {
                stale.push(`${page}: no longer has any multi-select facet — drop it from NO_SIBLING_ROUTE`);
                continue;
            }
            if (keys.every((key) => facetIsCsvParsed(page, key))) {
                stale.push(`${page}: every facet now resolves via the recursive walk — drop it from NO_SIBLING_ROUTE`);
            }
        }
        expect(stale).toEqual([]);
    });

    it('evidence is fixed, and is the reference implementation', () => {
        const source = readFileSync(join(API, 'evidence/route.ts'), 'utf8');
        expect(parsesCsv(source, 'type')).toBe(true);
        expect(parsesCsv(source, 'status')).toBe(true);
        expect(KNOWN_UNFIXED.evidence).toBeUndefined();
    });

    describe('planning.status — nested resolution + mutation proof', () => {
        // Regression coverage for the exact bug this file exists to catch:
        // a comma-joined `?status=DRAFT,ACTIVE` 500ing GET /planning/crop-plans,
        // invisible to the guard because `planning` was excluded rather than
        // resolved. These three assertions prove the NEW resolution actually
        // looks in the right place, not just that the case happens to pass.

        it('there is no sibling planning/route.ts — the old check point is genuinely absent', () => {
            expect(existsSync(join(API, 'planning/route.ts'))).toBe(false);
        });

        it('the recursive walk reaches the nested crop-plans route', () => {
            const routes = findRouteFiles(join(API, 'planning'));
            expect(routes.some((f) => f.endsWith(join('crop-plans', 'route.ts')))).toBe(true);
        });

        it('today, planning.status resolves as CSV-parsed via that nested route', () => {
            expect(facetIsCsvParsed('planning', 'status')).toBe(true);
        });

        it('would be CAUGHT if crop-plans/route.ts reverted to a bare scalar status param (mutation proof)', () => {
            // Reproduces the exact pre-fix shape: no `csvEnumField` /
            // `parseCsvEnumParam`, just a plain optional string forwarded
            // straight through to Prisma as an equality filter.
            const buggySource = `
                const QuerySchema = z
                    .object({
                        seasonId: z.string().optional(),
                        cropTypeId: z.string().optional(),
                        status: z.string().optional(),
                    })
                    .strip();
                const plans = await listCropPlans(ctx, {
                    seasonId: query.seasonId,
                    cropTypeId: query.cropTypeId,
                    status: query.status,
                });
            `;
            expect(parsesCsv(buggySource, 'status')).toBe(false);
        });
    });
});
