/**
 * Roadmap-11 PR-1 — Empty states with personality.
 *
 * After R10's discipline phase, the chrome is consistent but the
 * empty pages still read as bare strings. R11 anchors on delight —
 * every list-page empty state goes through the `<EmptyState>`
 * primitive with three vocabularies:
 *
 *   • `no-records` — "you have no data yet" (onboarding hint with
 *     primary action where appropriate).
 *   • `no-results` — "your filter matched nothing" (always pairs
 *     with a "Clear filters" secondary action).
 *   • `missing-prereqs` — "do X first" (primary action to the
 *     prerequisite flow).
 *
 * This ratchet locks the migration: each adopted page mounts the
 * `<EmptyState>` primitive inside its `emptyState` prop, not a bare
 * string. New list pages can stay on strings via EXEMPTIONS with a
 * written reason (sub-tables, dashboard composites, etc.).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Files that have been migrated to structured EmptyState empty
 * states on their DataTable mount. Direction of travel: this list
 * grows over time. Removing a file requires that the page no
 * longer mounts a DataTable, OR carries a written reason elsewhere.
 */
const ADOPTED_PAGES: string[] = [
    'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
    'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx',
    'src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx',
];

describe('Empty-state personality adoption (R11-PR1)', () => {
    test('every adopted page imports EmptyState from the canonical path', () => {
        const missing: string[] = [];
        for (const rel of ADOPTED_PAGES) {
            const abs = path.join(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
            const src = fs.readFileSync(abs, 'utf-8');
            if (
                !/from\s+['"]@\/components\/ui\/empty-state['"]/.test(src)
            ) {
                missing.push(rel);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `${missing.length} adopted page(s) missing the EmptyState import:\n  ` +
                    missing.join('\n  '),
            );
        }
    });

    test('every adopted page renders <EmptyState> as its emptyState prop', () => {
        const offenders: string[] = [];
        for (const rel of ADOPTED_PAGES) {
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
            // Look for the JSX usage in the file. The shape varies
            // (EntityListPage `emptyState:` vs DataTable `emptyState=`)
            // but every adopted page mounts the primitive somewhere.
            if (!/<EmptyState\b/.test(src)) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} adopted page(s) import EmptyState but don't render it:\n  ` +
                    offenders.join('\n  '),
            );
        }
    });

    test('every adopted page uses the canonical variant + size shape', () => {
        // Lock the shape: at least one `<EmptyState size="sm" variant="no-records|no-results">`
        // per file. Catches reverts that drop the structure back to bare strings.
        const offenders: string[] = [];
        for (const rel of ADOPTED_PAGES) {
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
            const hasSmVariant =
                /size="sm"[\s\S]{0,200}variant="(no-records|no-results|missing-prereqs)"/.test(
                    src,
                ) ||
                /variant="(no-records|no-results|missing-prereqs)"[\s\S]{0,200}size="sm"/.test(
                    src,
                );
            if (!hasSmVariant) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} adopted page(s) don't carry the canonical { size: 'sm', variant: 'no-records' | 'no-results' } EmptyState shape:\n  ` +
                    offenders.join('\n  '),
            );
        }
    });

    test('every adopted page with filters pairs no-results with a Clear filters action', () => {
        // If a page renders both an `hasActive` ternary AND a
        // `variant="no-results"` EmptyState, it should ALSO carry a
        // `'Clear filters'` action so the user can recover.
        const offenders: string[] = [];
        for (const rel of ADOPTED_PAGES) {
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
            const usesNoResults = /variant="no-results"/.test(src);
            if (!usesNoResults) continue;
            // Findings has no filters — exempt by lack of `hasActive` usage.
            if (!/\bhasActive\b/.test(src)) continue;
            // i18n (T06/T07/T08): the action label may be a literal or a
            // next-intl call under any binding — `tm('clearFilters')`,
            // `t('list.clearFilters')`, or (evidence) `tr('client.clearFilters')`.
            if (!/['"]Clear filters['"]|\w+\(['"][\w.]*clearFilters['"]\)/.test(src)) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} adopted page(s) use no-results EmptyState without a Clear filters action:\n  ` +
                    offenders.join('\n  '),
            );
        }
    });
});
