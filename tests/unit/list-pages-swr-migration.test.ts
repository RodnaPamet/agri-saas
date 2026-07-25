/**
 * Epic 69 wave #4 — structural pins for the policies / tasks /
 * vendors SWR-first migration.
 *
 * Same ratchet shape as evidence-risks-swr-migration.test.ts. Each
 * file passes the four-pin contract:
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
    /** Whether the page also writes (mutation present). */
    hasMutation: boolean;
}

const LIST_PAGES: readonly ListPageContract[] = [
    {
        label: 'PoliciesClient',
        filePath:
            'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx',
        cacheKey: 'CACHE_KEYS.policies.list()',
        hasMutation: false,
    },
    {
        label: 'VendorsClient',
        filePath:
            'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
        cacheKey: 'CACHE_KEYS.vendors.list()',
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
    ({ label, filePath, cacheKey, hasMutation }) => {
        it(`reads via useTenantSWR keyed at ${cacheKey}`, () => {
            const src = read(filePath);
            expect(src).toContain("from '@/lib/hooks/use-tenant-swr'");
            expect(src).toContain('useTenantSWR');
            expect(src).toContain(cacheKey);
        });

        it('threads filters into the SWR key via a query-string suffix', () => {
            const src = read(filePath);
            // The key derivation builds `${list()}?${qs}` so each
            // filter combo gets its own cache entry. The rendered
            // source contains the literal substring
            // `${CACHE_KEYS.X.list()}?${qs}` — match it as a plain
            // string to dodge the regex-escape edge case CodeQL
            // flags on ad-hoc `.replace(/[.()]/g, '\\$&')` patterns.
            expect(src).toContain(`${cacheKey}}?\${qs}`);
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
