/**
 * Roadmap-12 PR-1 — DataTable selection column default-on.
 *
 * Pre-R12 the select column was OPT-IN: a consumer only saw the
 * checkbox column if they passed `onRowSelectionChange` or
 * `selectionControls`. In practice exactly one page (Practices) did
 * — every other DataTable across the product had no checkbox
 * column at all, so tables visually differed (Practices has a
 * 48-px-wide first column with checkboxes; Risks doesn't).
 *
 * R12-PR1 flips the contract: `selectionEnabled` defaults to
 * `true`. Pages that genuinely don't want the column opt out via
 * `selectionEnabled={false}`. Bulk-action toolbars still wire
 * through `selectionControls`; without them, the checkboxes just
 * toggle row state. Premium products (Linear, Stripe, Vercel)
 * always render the select column on row-record tables — the
 * selection affordance is at least visible.
 *
 * This ratchet locks two invariants:
 *
 *   1. **Primitive default.** `selectionEnabled` in the Table
 *      function reads `props.selectionEnabled ?? true`. A future
 *      "tidy-up" that re-introduces the OR-gated check would
 *      re-break uniformity.
 *
 *   2. **No hand-rolled `id: 'select'` columns.** Pages that
 *      previously rolled their own square-checkbox select column
 *      (Tasks pre-R12-PR1) must not re-introduce them — the
 *      built-in column is the canonical shape.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

describe('DataTable selection default-on (R12-PR1)', () => {
    test('the Table primitive defaults `selectionEnabled` to true', () => {
        const src = fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/table/table.tsx'),
            'utf-8',
        );
        // Both call sites in the primitive must default to `true`.
        // The literal pattern `selectionEnabled ?? true` is the
        // canonical form (and the most readable in code review).
        const matches = src.match(/selectionEnabled[^\n]*\?\?\s*true/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBeGreaterThanOrEqual(2);
    });

    test("DataTable wrapper threads `selectionEnabled` through to useTable", () => {
        const src = fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/table/data-table.tsx'),
            'utf-8',
        );
        // The prop must be destructured and forwarded into the
        // tableProps object (both pagination branches).
        expect(src).toMatch(/selectionEnabled\??\s*[:,}]/);
        // Must appear at least twice in tableProps composition
        // (the two branches of the pagination discriminated union).
        const passThroughs = src.match(/^\s*selectionEnabled,?$/gm);
        expect(passThroughs).not.toBeNull();
        expect(passThroughs!.length).toBeGreaterThanOrEqual(2);
    });

    test('no app page hand-rolls a custom `id: "select"` column', () => {
        // Pre-R12 Tasks had its own custom square checkbox column
        // declared as `id: 'select'`. After the migration, the
        // built-in DataTable selection is the only path. Future
        // contributors who try to recreate the square checkbox via
        // a manual column trip this ratchet.
        //
        // EXEMPTIONS: pages where the `id: 'select'` column isn't a
        // row-record selection affordance but a meaningful entity
        // (e.g. "select which templates to install"). Each carries a
        // written reason.
        const EXEMPTIONS: Record<string, string> = {
            'src/app/t/[tenantSlug]/(app)/practices/templates/page.tsx':
                'Install-from-templates picker — `select` is the "include this template in the install set" toggle, not a row-record selection affordance.',
        };
        const stripComments = (s: string) =>
            s
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
        const offenders: string[] = [];
        const walk = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.name.endsWith('.tsx')) {
                    const rel = path.relative(ROOT, full);
                    if (EXEMPTIONS[rel]) continue;
                    const src = stripComments(fs.readFileSync(full, 'utf-8'));
                    if (/id:\s*['"]select['"]/.test(src)) {
                        offenders.push(rel);
                    }
                }
            }
        };
        walk(path.resolve(ROOT, 'src/app'));
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} app file(s) declare a custom \`id: 'select'\` column:\n  ` +
                    offenders.join('\n  ') +
                    '\n\nFix: remove the custom column. DataTable\'s built-in selection is default-on after R12-PR1; wire bulk state via `onRowSelectionChange` + `selectedRows` to keep your existing bulk-action toolbar working.\n' +
                    'OR add the file path to EXEMPTIONS with a written reason if the `select` column genuinely represents something other than row-record selection.',
            );
        }
    });
});
