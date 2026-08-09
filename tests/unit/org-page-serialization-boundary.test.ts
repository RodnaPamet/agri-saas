/**
 * Server→client serialization boundary ratchet for org list pages.
 *
 * The org drill-down pages (controls / evidence / tenants)
 * each cross the RSC boundary by passing usecase result rows into a
 * client-component table. The convention is:
 *
 *   import { toPlainJson } from '@/lib/server/to-plain-json';
 *   ...
 *   return <FooTable rows={toPlainJson(rows)} />;
 *
 * `toPlainJson` is a thin wrapper around `JSON.parse(JSON.stringify(x))`
 * with a docstring explaining why it should not be removed (Next
 * RSC payload normalisation, future Prisma row leakage, Date /
 * Decimal handling drift across Next versions). This ratchet
 * guards against three regression classes:
 *
 *   1. A future "the helper is just JSON.parse(JSON.stringify), inline
 *      it" cleanup that loses the documentation context — fails the
 *      "uses helper" assertion below.
 *   2. A future "this DTO is already plain, drop the round-trip"
 *      cleanup that removes the boundary entirely — fails the same
 *      assertion AND the negative-pattern assertion (no bare
 *      `<Table rows={rows}` after the boundary).
 *   3. A future page that adds a NEW org list surface and forgets
 *      the boundary altogether — the ratchet's coverage floor
 *      (`expect(checked.length).toBeGreaterThanOrEqual(4)`) breaks
 *      if a new page is added without it, since this list won't
 *      cover the new file.
 *
 * The helper itself is unit-tested in `to-plain-json.test.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

interface PageSpec {
    name: string;
    page: string;
    /** The client-island the page renders. Used in the "no bare
     *  rows={rows}" negative assertion to anchor the search. */
    tableTag: string;
}

const PAGES: PageSpec[] = [
    {
        name: 'controls',
        page: 'src/app/org/[orgSlug]/(app)/controls/page.tsx',
        tableTag: 'ControlsTable',
    },
    {
        name: 'evidence',
        page: 'src/app/org/[orgSlug]/(app)/evidence/page.tsx',
        tableTag: 'EvidenceTable',
    },
    {
        name: 'tenants',
        page: 'src/app/org/[orgSlug]/(app)/tenants/page.tsx',
        tableTag: 'TenantsTable',
    },
];

describe('org list pages — server→client serialization boundary', () => {
    it.each(PAGES)('$name page imports + uses toPlainJson at the RSC boundary', ({ page, tableTag }) => {
        expect(exists(page)).toBe(true);
        const src = read(page);

        // Helper imported from the canonical path.
        expect(src).toMatch(
            /import\s+\{\s*toPlainJson\s*\}\s+from\s+['"]@\/lib\/server\/to-plain-json['"]/,
        );

        // The client-component invocation MUST pass `rows` through
        // the helper. The negative assertion below catches "passes
        // raw rows".
        expect(src).toMatch(
            new RegExp(`<${tableTag}[\\s\\S]*?rows=\\{toPlainJson\\(`),
        );
    });

    it.each(PAGES)(
        '$name page does NOT pass rows directly without crossing the boundary',
        ({ page, tableTag }) => {
            const src = read(page);
            // Forbid `rows={rows}` and `rows={await ...}` — both bypass
            // the helper. The only acceptable shape is
            // `rows={toPlainJson(rows)}` (or `rows={toPlainJson(awaited)}`
            // if the future page composes inline).
            const bareRowsPattern = new RegExp(
                `<${tableTag}[\\s\\S]*?rows=\\{rows\\}`,
            );
            expect(src).not.toMatch(bareRowsPattern);
            // `JSON.parse(JSON.stringify(...))` inline is also out —
            // future maintainers should reach for the helper, not
            // re-introduce the inline pattern.
            expect(src).not.toMatch(/JSON\.parse\(JSON\.stringify/);
        },
    );

    it('coverage floor — every org list page is checked here', () => {
        // Snapshot: 4 list pages cross the RSC boundary today. If a
        // new page is added without an entry in PAGES, the floor
        // forces an explicit conversation rather than a silent miss.
        // Floor was 4 until the org risks page went with the register.
        expect(PAGES.length).toBeGreaterThanOrEqual(3);
    });

    it('the helper file itself exists and exports the function', () => {
        // Anti-regression: the most direct way for the boundary to
        // disappear is for the helper file to be deleted. Lock it.
        const helperPath = 'src/lib/server/to-plain-json.ts';
        expect(exists(helperPath)).toBe(true);
        const src = read(helperPath);
        expect(src).toMatch(/export\s+function\s+toPlainJson\s*</);
        // The docstring must explain WHY — guards against a future
        // "re-export of JSON.parse" with no context.
        expect(src).toMatch(/RSC|Server Component|server.{0,2}client/i);
    });
});
