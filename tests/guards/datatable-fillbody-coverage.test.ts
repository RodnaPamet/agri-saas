/**
 * Roadmap-12 PR-3 — DataTable fillBody coverage on list pages.
 *
 * The "card-style scrolling" UX — table card sits viewport-clamped
 * inside `<ListPageShell.Body>`, only the table body scrolls,
 * filters + header stay anchored — is what Practices / Risks /
 * Tasks / etc. all do. After R10-R11 every major entity list page
 * uses this pattern; this ratchet locks the contract.
 *
 * Rule: every file that mounts BOTH `<ListPageShell.Body>` AND
 * `<DataTable>` must pass `fillBody` to that DataTable. Without
 * `fillBody`, the DataTable's outer card sizes to its content and
 * the page falls back to natural document scroll — the very thing
 * Epic 52 / R10 / R11 collectively closed.
 *
 * Pages that mount `<DataTable>` WITHOUT `<ListPageShell.Body>`
 * (multi-section dashboards, sub-tables on detail pages, wizards,
 * report layouts) are out of scope: they intentionally don't fit
 * the card-clamped scroll pattern. They're handled by
 * `list-page-shell-coverage.test.ts` already.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const APP_ROOT = path.resolve(ROOT, 'src/app/t/[tenantSlug]/(app)');

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, results);
        else if (entry.name.endsWith('.tsx')) results.push(full);
    }
    return results;
}

describe('DataTable fillBody coverage on list pages (R12-PR3)', () => {
    test('every page mounting <ListPageShell.Body> + <DataTable> passes fillBody', () => {
        // Strip JS/TS comments so doc-block references to `<DataTable>`
        // don't trip the scanner.
        const stripComments = (s: string) =>
            s
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
        const offenders: string[] = [];
        for (const file of walk(APP_ROOT)) {
            const content = stripComments(fs.readFileSync(file, 'utf-8'));
            const mountsShellBody = /<ListPageShell\.Body\b/.test(content);
            const mountsDataTable = /<DataTable\b/.test(content);
            if (!mountsShellBody || !mountsDataTable) continue;
            // Find each `<DataTable` open + capture the next ~1500
            // chars (the JSX opening tag + its prop block). The
            // regex `<DataTable\b[\s\S]*?(?:\/>|>)` falls apart on
            // `<DataTable<X>` because the first `>` closes the
            // generic-type angle bracket, not the JSX tag. Using a
            // fixed-window slice is more robust: every fillBody
            // declaration sits within the first ~30 lines after the
            // tag.
            const dataTableStarts = Array.from(
                content.matchAll(/<DataTable\b/g),
            ).map((m) => m.index ?? 0);
            if (dataTableStarts.length === 0) continue;
            const anyWithoutFillBody = dataTableStarts.some((idx) => {
                const window = content.slice(idx, idx + 1500);
                return !/\bfillBody\b/.test(window);
            });
            if (anyWithoutFillBody) {
                offenders.push(
                    path
                        .relative(APP_ROOT, file)
                        .split(path.sep)
                        .join('/'),
                );
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} list page(s) mount <DataTable> inside <ListPageShell.Body> without passing \`fillBody\`:\n  ` +
                    offenders.join('\n  ') +
                    '\n\nFix: add `fillBody` to the DataTable. Without it, the table card sizes to content and the page reverts to natural document scroll instead of the card-clamped viewport-fill pattern every other list page uses.',
            );
        }
    });

    test('the DataTable primitive defines the fillBody contract', () => {
        const src = fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/table/data-table.tsx'),
            'utf-8',
        );
        // The flex chain that fillBody activates: card uses
        // `md:flex md:flex-col md:max-h-full md:min-h-0
        // md:overflow-hidden`; the scroll wrapper inside uses
        // `md:max-h-full md:min-h-0 md:overflow-y-auto`. Locking the
        // signature so a tidy-up can't strip the mobile-aware
        // breakpoint prefixes and silently break responsive layouts.
        expect(src).toMatch(/md:flex\s+md:flex-col\s+md:max-h-full\s+md:min-h-0\s+md:overflow-hidden/);
        expect(src).toMatch(/md:max-h-full\s+md:min-h-0\s+md:overflow-y-auto/);
    });
});
