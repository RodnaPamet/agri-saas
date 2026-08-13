/**
 * Epic 69 wave #4 — structural pins for the SWR-first list pages.
 *
 * Originally pinned the policies / tasks / vendors clients. GRC
 * teardown phase 2 deleted the policies + vendors pages with their
 * models (tasks had already been retired into /farm-tasks), which
 * would have left this ratchet with an empty registry. Rather than
 * drop the regression class, it is RE-POINTED at JournalClient —
 * the surviving list page that carries the identical contract
 * (useTenantSWR + CACHE_KEYS list key + qs suffix + fallbackData
 * gated by filtersMatchInitial, zero React Query). Every pin below
 * is unchanged in strength; only the subject moved.
 *
 * Each file passes the four-pin contract:
 *
 *   1. Reads via `useTenantSWR(CACHE_KEYS.<resource>.list())` with a
 *      filter-aware query-string suffix on the key.
 *   2. Server-rendered `initialData` lands as `fallbackData`,
 *      gated by `filtersMatchInitial` so the hook fires fresh
 *      on URL-driven filter changes.
 *   3. Mutations (where present) flow through `useTenantMutation`
 *      with an `optimisticUpdate` closure.
 *   4. Zero TanStack React Query symbols remain on the file —
 *      negative pins on `@tanstack/react-query`, `queryKeys`,
 *      `useQuery`, `useQueryClient`, `invalidateQueries`.
 *
 * Adding the next list page (e.g. assets) is a one-block extension
 * to the data-driven `LIST_PAGES` table.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

interface ListPageContract {
    label: string;
    filePath: string;
    cacheKey: string;
    /**
     * The exact expression interpolated after the `?` in the SWR key,
     * so the query-string-suffix pin stays an exact-substring match
     * rather than a loose regex.
     */
    keySuffixExpr: string;
    /** Whether the page also writes (mutation present). */
    hasMutation: boolean;
}

const LIST_PAGES: readonly ListPageContract[] = [
    {
        label: 'JournalClient',
        filePath:
            'src/app/t/[tenantSlug]/(app)/journal/JournalClient.tsx',
        cacheKey: 'CACHE_KEYS.journal.list()',
        keySuffixExpr: 'p.toString()',
        hasMutation: false,
    },
] as const;

function read(p: string): string {
    return fs.readFileSync(path.join(ROOT, p), 'utf-8');
}

/** Strip block + line comments so prose mentions of removed
 *  React Query symbols (in migration docstrings) don't trip the
 *  negative assertions. */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

describe.each(LIST_PAGES)(
    '$label — Epic 69 SWR migration',
    ({ label, filePath, cacheKey, keySuffixExpr, hasMutation }) => {
        it(`reads via useTenantSWR keyed at ${cacheKey}`, () => {
            const src = read(filePath);
            expect(src).toContain("from '@/lib/hooks/use-tenant-swr'");
            expect(src).toContain('useTenantSWR');
            expect(src).toContain(cacheKey);
        });

        it('threads filters into the SWR key via a query-string suffix', () => {
            const src = read(filePath);
            // The key derivation builds `${list()}?${<suffix>}` so each
            // filter combo gets its own cache entry. The rendered
            // source contains the literal substring
            // `${CACHE_KEYS.X.list()}?${<suffix>}` — match it as a plain
            // string to dodge the regex-escape edge case CodeQL
            // flags on ad-hoc `.replace(/[.()]/g, '\\$&')` patterns.
            // The suffix expression is declared per page so this stays
            // an exact match after the GRC-teardown re-point.
            expect(src).toContain(`${cacheKey}}?\${${keySuffixExpr}}`);
        });

        it('passes server-rendered data as fallbackData', () => {
            const src = read(filePath);
            expect(src).toContain('fallbackData');
            expect(src).toContain('filtersMatchInitial');
        });

        if (hasMutation) {
            it('writes via useTenantMutation with an optimisticUpdate closure', () => {
                const src = read(filePath);
                expect(src).toContain(
                    "from '@/lib/hooks/use-tenant-mutation'",
                );
                expect(src).toContain('useTenantMutation');
                expect(src).toContain('optimisticUpdate:');
            });

            it('fans out to sibling filter variants via swrMutate matcher', () => {
                const src = read(filePath);
                expect(src).toContain('swrMutate');
                expect(src).toMatch(/swrMutate\(\s*\(key\)/);
            });
        }

        it('does NOT use TanStack React Query', () => {
            const code = stripComments(read(filePath));
            expect(code).not.toMatch(
                /from\s+['"]@tanstack\/react-query['"]/,
            );
            expect(code).not.toMatch(/\bqueryKeys\b/);
            expect(code).not.toMatch(/\buseQuery\b/);
            expect(code).not.toMatch(/\buseQueryClient\b/);
            expect(code).not.toMatch(/\.invalidateQueries\b/);
        });

        it(`does not invoke router.refresh() in ${label}`, () => {
            const code = stripComments(read(filePath));
            expect(code).not.toMatch(/router\.refresh\s*\(/);
        });
    },
);

// ─── Migration coverage ratchet ───────────────────────────────────

describe('Epic 69 list-page coverage ratchet', () => {
    it('every major list page in LIST_PAGES has migrated', () => {
        // Any file that still imports `@tanstack/react-query` from
        // the LIST_PAGES set means the migration is incomplete.
        // Other client surfaces (modals, detail pages, etc.) may
        // legitimately still use React Query during incremental
        // adoption — this ratchet only covers the major lists.
        const violations = LIST_PAGES.filter((p) => {
            const code = stripComments(read(p.filePath));
            return /from\s+['"]@tanstack\/react-query['"]/.test(code);
        }).map((p) => p.label);
        expect(violations).toEqual([]);
    });
});
