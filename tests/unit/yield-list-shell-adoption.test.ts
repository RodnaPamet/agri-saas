/**
 * Structural ratchet: `YieldClient` adopts `<EntityListPage>`.
 *
 * Mirrors `practices-client-shell-adoption.test.ts`. Locks the invariant
 * that the grain Yield list page sits on the shared shell rather than
 * hand-rolling inline composition. Asserts the season/field facets thread
 * through, the create/edit modal mounts as a child, and the destructive
 * delete routes through the undo-toast hook.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const YIELD_CLIENT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/grain/yield/YieldClient.tsx',
);

const source = readFileSync(YIELD_CLIENT, 'utf8');

describe('YieldClient — EntityListPage adoption', () => {
    it('imports EntityListPage from the canonical path', () => {
        expect(source).toMatch(
            /import\s*\{\s*EntityListPage\s*\}\s*from\s*['"]@\/components\/layout\/EntityListPage['"];?/,
        );
    });

    it('mounts <EntityListPage<YieldRow>> at the top level of render', () => {
        expect(source).toContain('<EntityListPage<YieldRow>');
        expect(source).toContain('</EntityListPage>');
    });

    it('does NOT hand-roll <ListPageShell> directly (shell owns the composition)', () => {
        expect(source).not.toMatch(
            /import\s*\{[^}]*\bListPageShell\b[^}]*\}\s*from\s*['"]@\/components\/layout\/ListPageShell['"]/,
        );
    });

    it('does NOT hand-roll <FilterToolbar> directly (shell owns the wiring)', () => {
        expect(source).not.toMatch(
            /import\s*\{[^}]*\bFilterToolbar\b[^}]*\}\s*from\s*['"]@\/components\/filters\/FilterToolbar['"]/,
        );
    });

    it('threads filters through the shell (defs + live search box)', () => {
        expect(source).toMatch(/filters\s*=\s*\{\{/);
        expect(source).toContain('defs: liveFilterDefs');
        expect(source).toContain("searchId: 'grain-yield-search'");
        expect(source).toMatch(/searchPlaceholder:\s*\w+\(/);
    });

    it('derives season/field facet options from the loaded rows', () => {
        expect(source).toContain('buildYieldFilters');
    });

    it('threads the table config through the shell', () => {
        expect(source).toMatch(/table\s*=\s*\{\{/);
        expect(source).toMatch(/data:\s*records\b/);
        expect(source).toContain('columns,');
        expect(source).toContain('getRowId');
        expect(source).toContain("'data-testid': 'grain-yield-table'");
    });

    it('uses React Query hydrated with server initialData', () => {
        expect(source).toMatch(/useQuery</);
        // The SSR prop is the paged envelope ({ rows, totalCount,
        // truncated }), not a bare row array — the list read reports
        // whether the 500-row cap bit, which the page has to show.
        expect(source).toContain('initialPayload');
        expect(source).toMatch(/initialData:\s*noFacets\s*\?\s*initialPayload/);
    });

    it('reports the row cap instead of truncating silently', () => {
        // A farm past the cap used to see 500 rows and be told nothing, so
        // any total read off this page was wrong.
        expect(source).toContain('truncated');
        expect(source).toContain('truncatedNotice');
    });

    it('sends free-text search to the server, not the loaded page', () => {
        // An in-memory filter over the loaded rows reported "no results"
        // for a record that exists on row 501.
        expect(source).toMatch(/params\.set\('q'/);
        expect(source).not.toMatch(/rawRecords\.filter\(/);
    });

    it('gates the create button behind canWrite and uses the bare-noun + Plus pattern', () => {
        expect(source).toMatch(/permissions\.canWrite\s*\?/);
        expect(source).toContain('new-yield-btn');
        expect(source).toContain('icon={<Plus');
        expect(source).not.toMatch(/>\s*New Yield\s*</);
        expect(source).not.toMatch(/>\s*Create Yield\s*</);
    });

    it('wires the create/edit modal as a child', () => {
        expect(source).toContain('<YieldFormModal');
    });

    it('wires destructive delete through the undo-toast hook', () => {
        expect(source).toContain('useToastWithUndo');
        expect(source).toMatch(/triggerUndoToast\(/);
    });
});
