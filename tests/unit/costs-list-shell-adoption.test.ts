/**
 * Structural ratchet: `CostsClient` adopts `<EntityListPage>`.
 *
 * Mirrors `practices-client-shell-adoption.test.ts`. Locks the invariant
 * that the grain Costs entry register sits on the shared shell rather
 * than hand-rolling inline `<ListPageShell>` + `<FilterToolbar>` +
 * `<DataTable>` composition. Also asserts the create/edit modal mounts
 * as a child and the filter + table config thread through the shell.
 *
 * What it does NOT enforce: per-cell rendering, exact column copy. Those
 * are covered by downstream rendered/E2E flows. This file ONLY asserts
 * the shell-adoption contract for the page.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const COSTS_CLIENT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/grain/costs/CostsClient.tsx',
);

const source = readFileSync(COSTS_CLIENT, 'utf8');

describe('CostsClient — EntityListPage adoption', () => {
    it('imports EntityListPage from the canonical path', () => {
        expect(source).toMatch(
            /import\s*\{\s*EntityListPage\s*\}\s*from\s*['"]@\/components\/layout\/EntityListPage['"];?/,
        );
    });

    it('mounts <EntityListPage<CostRow>> at the top level of render', () => {
        expect(source).toContain('<EntityListPage<CostRow>');
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
        expect(source).toContain("searchId: 'grain-costs-search'");
        expect(source).toMatch(/searchPlaceholder:\s*\w+\(/);
    });

    it('threads the table config through the shell', () => {
        expect(source).toMatch(/table\s*=\s*\{\{/);
        expect(source).toMatch(/data:\s*rows\b/);
        expect(source).toContain('columns,');
        expect(source).toContain('getRowId');
        expect(source).toContain("'data-testid': 'grain-costs-table'");
    });

    it('uses React Query hydrated with server initialData', () => {
        expect(source).toMatch(/useQuery</);
        expect(source).toContain('initialData:');
        expect(source).toContain('initialRows');
    });

    it('gates the create button behind canWrite and uses the bare-noun + Plus pattern', () => {
        expect(source).toMatch(/permissions\.canWrite\s*\?/);
        expect(source).toContain('new-cost-btn');
        expect(source).toContain('icon={<Plus');
        // Bare noun, never verb-prefixed.
        expect(source).not.toMatch(/>\s*New Contract\s*</);
        expect(source).not.toMatch(/>\s*Create Contract\s*</);
    });

    it('wires the create/edit modal as a child (page-state lives next to the page)', () => {
        expect(source).toContain('<CostEntryFormModal');
    });

    it('wires destructive delete through the undo-toast hook', () => {
        expect(source).toContain('useToastWithUndo');
        expect(source).toMatch(/triggerUndoToast\(/);
    });
});
