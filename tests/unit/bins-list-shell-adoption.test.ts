/**
 * Structural ratchet: `BinsClient` adopts `<EntityListPage>`.
 *
 * Mirrors `practices-client-shell-adoption.test.ts`. Locks the invariant
 * that the grain Bins list page sits on the shared shell rather than
 * hand-rolling inline composition. Bins have NO delete route — the page
 * provides create + edit only, so this test does NOT assert an undo-toast
 * delete wiring (and asserts the form modal mounts as a child).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const BINS_CLIENT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/grain/bins/BinsClient.tsx',
);

const source = readFileSync(BINS_CLIENT, 'utf8');

describe('BinsClient — EntityListPage adoption', () => {
    it('imports EntityListPage from the canonical path', () => {
        expect(source).toMatch(
            /import\s*\{\s*EntityListPage\s*\}\s*from\s*['"]@\/components\/layout\/EntityListPage['"];?/,
        );
    });

    it('mounts <EntityListPage<BinRow>> at the top level of render', () => {
        expect(source).toContain('<EntityListPage<BinRow>');
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

    it('threads the live search box through the shell', () => {
        expect(source).toMatch(/filters\s*=\s*\{\{/);
        expect(source).toContain("searchId: 'grain-bins-search'");
        expect(source).toMatch(/searchPlaceholder:\s*\w+\(/);
    });

    it('threads the table config through the shell', () => {
        expect(source).toMatch(/table\s*=\s*\{\{/);
        expect(source).toMatch(/data:\s*bins\b/);
        expect(source).toContain('columns,');
        expect(source).toContain('getRowId');
        expect(source).toContain("'data-testid': 'grain-bins-table'");
    });

    it('uses React Query hydrated with server initialData', () => {
        expect(source).toMatch(/useQuery</);
        expect(source).toContain('initialData: initialBins');
    });

    it('gates the create button behind canWrite and uses the bare-noun + Plus pattern', () => {
        expect(source).toMatch(/permissions\.canWrite\s*\?/);
        expect(source).toContain('new-bin-btn');
        expect(source).toContain('icon={<Plus');
        expect(source).not.toMatch(/>\s*New Bin\s*</);
        expect(source).not.toMatch(/>\s*Create Bin\s*</);
    });

    it('wires the create/edit modal as a child', () => {
        expect(source).toContain('<BinFormModal');
    });

    it('does NOT wire a delete action (bins have no delete route)', () => {
        // Defence against a future PR adding a delete that the API can't
        // service (404). Bins are create + edit only.
        expect(source).not.toContain('useToastWithUndo');
        expect(source).not.toMatch(/method:\s*['"]DELETE['"]/);
    });
});
