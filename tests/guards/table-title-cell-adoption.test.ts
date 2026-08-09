/**
 * Roadmap-13 PR-1 — TableTitleCell adoption.
 *
 * Pre-R13, every entity list page rendered its title cell with a
 * subtly-different shape — different wrapping element (`<div>` vs
 * `<span>` vs `<Link>`), different className strings, different
 * inline siblings (icons, badges, sub-text). The user looked at
 * the product side-by-side and said "the tables still have
 * different format."
 *
 * R13-PR1 introduces `<TableTitleCell>` as the canonical title-
 * column primitive. Entity list pages migrated:
 * Controls / Risks / Policies / Evidence / Vendors /
 * Assets / Findings / Farm tasks.
 *
 * Ratchet locks two invariants:
 *
 *   1. **Primitive contract.** TableTitleCell renders a single
 *      inline element (no block children). The locked className
 *      base is `font-medium text-content-emphasis text-sm` — the
 *      visual signature that means "this is the row's identifier."
 *
 *   2. **Adoption.** Every entity list page imports +
 *      mounts <TableTitleCell> in its title-column cell.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const ADOPTED_PAGES = [
    'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx',
    'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
    'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/farm-tasks/FarmTasksClient.tsx',
];

describe('TableTitleCell adoption (R13-PR1)', () => {
    test('TableTitleCell primitive carries the canonical className base', () => {
        const src = fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/table-title-cell.tsx'),
            'utf-8',
        );
        // The three load-bearing tokens that define the
        // "this-is-an-identifier" visual signature.
        expect(src).toMatch(/font-medium\s+text-content-emphasis\s+text-sm/);
    });

    test('TableTitleCell primitive renders inline elements only (no block children)', () => {
        const src = fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/table-title-cell.tsx'),
            'utf-8',
        );
        // The primitive renders ONLY `<Link>` (inline) or `<span>`
        // (inline). Locking out `<div>` / `<p>` here prevents a
        // future tidy-up from re-introducing block children that
        // would push row height past the DataTable primitive's
        // 44px baseline.
        expect(src).not.toMatch(/^\s*<div\b/m);
        expect(src).not.toMatch(/^\s*<p\b/m);
    });

    test('every entity list page imports + mounts TableTitleCell', () => {
        const missing: string[] = [];
        for (const rel of ADOPTED_PAGES) {
            const abs = path.join(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
            const src = fs.readFileSync(abs, 'utf-8');
            const imports =
                /from\s+['"]@\/components\/ui\/table-title-cell['"]/.test(src);
            const mounts = /<TableTitleCell\b/.test(src);
            if (!imports || !mounts) {
                missing.push(rel);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `${missing.length} entity list page(s) don't import + mount TableTitleCell:\n  ` +
                    missing.join('\n  '),
            );
        }
    });

    test('no entity list page renders an inline-styled title cell (font-medium text-content-emphasis manually)', () => {
        // Detects the prior anti-pattern: a `cell:` render in the
        // title column that hard-codes `font-medium
        // text-content-emphasis` instead of using TableTitleCell.
        // Caught reliably enough by looking for the literal
        // className triplet inside a 600-char window after the
        // `accessorKey: 'title'|'name'|'code'` declaration.
        const stripComments = (s: string) =>
            s
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
        const offenders: string[] = [];
        for (const rel of ADOPTED_PAGES) {
            const src = stripComments(
                fs.readFileSync(path.join(ROOT, rel), 'utf-8'),
            );
            // Find each `accessorKey: 'title'|'name'|'code'` site
            // and check the next ~600 chars.
            const matches = src.matchAll(
                /(?:accessorKey|id):\s*['"](?:title|name|code)['"][\s\S]{0,600}/g,
            );
            for (const m of matches) {
                const window = m[0];
                if (/font-medium\s+text-content-emphasis/.test(window)
                    && !/<TableTitleCell\b/.test(window)) {
                    offenders.push(rel);
                    break;
                }
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} page(s) still hand-roll an inline title-cell with the canonical className triplet instead of <TableTitleCell>:\n  ` +
                    offenders.join('\n  '),
            );
        }
    });
});
