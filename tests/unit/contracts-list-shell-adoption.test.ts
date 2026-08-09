/**
 * Structural ratchet: `ContractsClient` adopts `<EntityListPage>`.
 *
 * Mirrors `practices-client-shell-adoption.test.ts`. Locks the invariant
 * that the grain Contracts list page sits on the shared shell rather
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

const CONTRACTS_CLIENT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/grain/contracts/ContractsClient.tsx',
);

const source = readFileSync(CONTRACTS_CLIENT, 'utf8');

describe('ContractsClient — EntityListPage adoption', () => {
    it('imports EntityListPage from the canonical path', () => {
        expect(source).toMatch(
            /import\s*\{\s*EntityListPage\s*\}\s*from\s*['"]@\/components\/layout\/EntityListPage['"];?/,
        );
    });

    it('mounts <EntityListPage<ContractRow>> at the top level of render', () => {
        expect(source).toContain('<EntityListPage<ContractRow>');
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
        expect(source).toContain("searchId: 'grain-contracts-search'");
        expect(source).toMatch(/searchPlaceholder:\s*\w+\(/);
    });

    it('threads the table config through the shell', () => {
        expect(source).toMatch(/table\s*=\s*\{\{/);
        expect(source).toMatch(/data:\s*contracts\b/);
        expect(source).toContain('columns,');
        expect(source).toContain('getRowId');
        expect(source).toContain("'data-testid': 'grain-contracts-table'");
    });

    it('uses React Query hydrated with server initialData', () => {
        expect(source).toMatch(/useQuery</);
        expect(source).toContain('initialData:');
        expect(source).toContain('initialContracts');
    });

    it('gates the create button behind canWrite and uses the bare-noun + Plus pattern', () => {
        expect(source).toMatch(/permissions\.canWrite\s*\?/);
        expect(source).toContain('new-contract-btn');
        expect(source).toContain('icon={<Plus');
        // Bare noun, never verb-prefixed.
        expect(source).not.toMatch(/>\s*New Contract\s*</);
        expect(source).not.toMatch(/>\s*Create Contract\s*</);
    });

    it('wires the create/edit modal as a child (page-state lives next to the page)', () => {
        expect(source).toContain('<ContractFormModal');
    });

    it('wires destructive delete through the undo-toast hook', () => {
        expect(source).toContain('useToastWithUndo');
        expect(source).toMatch(/triggerUndoToast\(/);
    });
});
