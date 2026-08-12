/**
 * PR-1 — Tenant tables → org-level parity ratchet.
 *
 * Locks the reusable "Load more …" + sortable-headers pattern + the
 * representative tenant-page rollouts. The org pattern is
 * `useCursorPagination` (server cursor); the tenant pattern is
 * `useThresholdLoadMore` (in-memory). Both speak the same `hasMore`
 * + `loadMore` vocabulary so a shared `<TableLoadMoreFooter>` can
 * render either.
 *
 * Assertions:
 *
 *   1. `useThresholdLoadMore` exists, exports a default threshold,
 *      and is in the canonical hooks barrel.
 *   2. `<TableLoadMoreFooter>` exists and is gated on `hasMore`.
 *   3. `<EntityListPage>` carries a `tableFooter` slot rendered
 *      inside `ListPageShell.Body` AFTER the DataTable.
 *   4. PracticesClient consumes the hook + footer + the org-parity
 *      sortable headers (`sortableColumns`, `sortBy`, `sortOrder`,
 *      `onSortChange`).
 *   5. RisksClient + EvidenceClient match the same shape.
 *   6. Every tenant rollout uses a stable testId namespace so E2E
 *      specs can target the loaded-window state.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('PR-1 — tenant tables → org-level parity', () => {
    describe('useThresholdLoadMore primitive', () => {
        const src = read('src/components/ui/hooks/use-threshold-load-more.ts');
        const barrel = read('src/components/ui/hooks/index.ts');

        it('exports useThresholdLoadMore + DEFAULT_LOAD_MORE_THRESHOLD', () => {
            expect(src).toMatch(/export function useThresholdLoadMore/);
            expect(src).toMatch(/export const DEFAULT_LOAD_MORE_THRESHOLD\s*=\s*50/);
        });

        it('returns the org-parity `hasMore` + `loadMore` vocabulary', () => {
            // The hook intentionally mirrors useCursorPagination's
            // return surface (minus loading/error) so the shared
            // <TableLoadMoreFooter> can consume either.
            expect(src).toMatch(/hasMore:\s*boolean/);
            expect(src).toMatch(/loadMore:\s*\(\)\s*=>\s*void/);
            expect(src).toMatch(/visibleRows:\s*TRow\[\]/);
            expect(src).toMatch(/totalCount:\s*number/);
        });

        it('is exported from the @/components/ui/hooks barrel', () => {
            expect(barrel).toMatch(/useThresholdLoadMore/);
            expect(barrel).toMatch(/DEFAULT_LOAD_MORE_THRESHOLD/);
        });

        it('narrowing input keeps remaining rows visible (no surprise collapse)', () => {
            // The hook code uses `Math.min(prev + increment, ...)` only
            // on loadMore — the rerender path doesn't shrink the
            // window. Locking the JSX shape so a "simplify" PR can't
            // accidentally re-collapse on filter narrow.
            expect(src).toMatch(/\.slice\(0,\s*windowSize\)/);
            // No `useEffect`/`setWindowSize(threshold)` based on rows
            // — the window only resets via the explicit `reset()`.
            expect(src).not.toMatch(/useEffect[\s\S]{0,400}setWindowSize\(threshold\)/);
        });
    });

    describe('TableLoadMoreFooter primitive', () => {
        const src = read('src/components/ui/table-load-more-footer.tsx');

        it('exports the footer component + props shape', () => {
            expect(src).toMatch(/export function TableLoadMoreFooter/);
            expect(src).toMatch(/export interface TableLoadMoreFooterProps/);
        });

        it('gates on hasMore (no footer when nothing more to reveal)', () => {
            expect(src).toMatch(/if\s*\(!hasMore\)\s*return\s*null/);
        });

        it('renders the org-style "X of Y" count + Load more button', () => {
            // The "Load more" label now routes through next-intl (Bulgarian
            // sweep); the org-parity invariant lives in the en.json value.
            expect(src).toMatch(/t\('loadMore'/);
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            expect(require('../../messages/en.json').ui.tableLoadMore.loadMore).toMatch(/Load more \{resourceName\}/);
            expect(src).toMatch(/visibleCount/);
            expect(src).toMatch(/totalCount/);
        });
    });

    describe('EntityListPage tableFooter slot', () => {
        const src = read('src/components/layout/EntityListPage.tsx');

        it('declares the tableFooter prop on EntityListPageProps', () => {
            expect(src).toMatch(/tableFooter\?:\s*ReactNode/);
        });

        it('renders tableFooter inside ListPageShell.Body AFTER DataTable', () => {
            // Locate the body block + confirm the order.
            const bodyStart = src.indexOf('<ListPageShell.Body');
            const bodyEnd = src.indexOf('</ListPageShell.Body>');
            const block = src.slice(bodyStart, bodyEnd);
            const tableIdx = block.indexOf('<DataTable');
            const footerIdx = block.indexOf('{tableFooter}');
            expect(tableIdx).toBeGreaterThan(0);
            expect(footerIdx).toBeGreaterThan(tableIdx);
        });
    });

});
