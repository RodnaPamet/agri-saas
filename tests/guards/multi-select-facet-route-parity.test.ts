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
const KNOWN_UNFIXED: Readonly<Record<string, readonly string[]>> = {
    assets: ['criticality', 'status', 'type'],
    controls: ['category', 'ownerUserId', 'status'],
    'farm-tasks': ['assigneeUserId', 'status'],
    journal: ['crop', 'status', 'type'],
    policies: ['category', 'status'],
    vendors: ['criticality', 'riskRating', 'status'],
};

/** Pages whose facets are handled somewhere other than a sibling route.ts. */
const NO_SIBLING_ROUTE = new Set(['exchange', 'grain/yield', 'planning', 'tests']);

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

/** True when the route parses `key` as a comma-joined list. */
function parsesCsv(routeSource: string, key: string): boolean {
    const field = routeSource.match(new RegExp(`\\n\\s*${key}:\\s*([^\\n]*)`));
    if (field && /csvEnumField|csvIdField/.test(field[1])) return true;
    // The imperative helpers are equally valid.
    return new RegExp(`parseCsv(Enum|Id)Param\\(\\s*[^)]*${key}`).test(routeSource);
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

        const route = join(API, page, 'route.ts');
        if (!existsSync(route)) return;

        const ok = parsesCsv(readFileSync(route, 'utf8'), key);
        if (ok) return;

        // Not parsed — it must be an acknowledged, documented offender.
        expect(KNOWN_UNFIXED[page] ?? []).toContain(key);
    });

    it('the backlog has no stale entries', () => {
        // An entry that is now CSV-parsed must be deleted in the same diff
        // that fixed it, or the list stops describing reality.
        const stale: string[] = [];
        for (const [page, keys] of Object.entries(KNOWN_UNFIXED)) {
            const route = join(API, page, 'route.ts');
            if (!existsSync(route)) {
                stale.push(`${page}: route no longer exists`);
                continue;
            }
            const source = readFileSync(route, 'utf8');
            for (const key of keys) {
                if (parsesCsv(source, key)) stale.push(`${page}.${key} is fixed — remove it from KNOWN_UNFIXED`);
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
});
