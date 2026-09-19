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
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
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

    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `walk` (line 28) to a constant and NOTHING
    // failed. The consumption is `for (const file of walk(APP_ROOT))`, so
    // the non-iterable guts (`0`, `null`, `undefined`, `false`, `{}`) throw
    // at the for-of and were already caught — but `[]`, `''`, `new Set()`
    // and `new Map()` all survive: the loop body never runs, `offenders`
    // stays empty, and the guard reports a clean sweep of a tree it never
    // opened. "Scanned 174 pages, every DataTable passes fillBody" and
    // "scanned nothing" were the same green.
    //
    // The `#875` throw at the top of `walk` cannot catch this: it lives
    // INSIDE the function being gutted, so the gut deletes the defence
    // against exactly the failure the gut produces.
    //
    // Floors below were MEASURED at d564bb406 (2026-09-19) and are set far
    // under reality so feature PRs never have to move them:
    //   • 174 `.tsx` files under APP_ROOT            → floor 80
    //   • 172 of them nested at depth >= 2           → floor 40
    //   •  15 `.ts` files the extension filter drops → asserted non-empty
    //   •  12 files mount BOTH markers (13 DataTable sites) → floor 4

    test('control: walk() returns the real page population, recursively', () => {
        const files = walk(APP_ROOT);

        // (a) A real population per root. Kills [] / '' / Set / Map.
        expect(files.length).toBeGreaterThanOrEqual(80);

        // (b) Recursion is the one behaviour the gut set cannot express, and
        // it is load-bearing here: only 2 of the 174 `.tsx` files sit
        // directly under APP_ROOT, and ALL 12 in-scope pages are nested, so
        // a walk that stopped recursing would scan an in-scope population of
        // zero while returning a non-empty list.
        const nested = files.filter((f) =>
            path.relative(APP_ROOT, f).includes(path.sep),
        );
        expect(nested.length).toBeGreaterThanOrEqual(40);

        // (c) Exact set equality against the PLATFORM's own recursion — an
        // independent oracle, not a second copy of `walk`, so it cannot
        // drift with it and cannot go stale when pages move.
        const sweep = fs
            .readdirSync(APP_ROOT, { recursive: true, withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith('.tsx'))
            .map((e) => path.join(e.parentPath, e.name))
            .sort();
        expect([...files].sort()).toEqual(sweep);
    });

    test('control: walk() excludes what it claims to exclude', () => {
        const files = walk(APP_ROOT);

        // An "every" over an empty list is a PASS, so prove the exclusion
        // has something to bite on before asserting it bit: the tree really
        // does contain non-`.tsx` files (15 `.ts` modules — filter-defs,
        // form hooks, breadcrumb roots) sitting beside the pages.
        const excluded = fs
            .readdirSync(APP_ROOT, { recursive: true, withFileTypes: true })
            .filter((e) => e.isFile() && !e.name.endsWith('.tsx'))
            .map((e) => path.join(e.parentPath, e.name));
        expect(excluded.length).toBeGreaterThan(0);

        const collected = new Set(files);
        for (const f of excluded) expect(collected.has(f)).toBe(false);
        for (const f of files) expect(f.endsWith('.tsx')).toBe(true);
    });

    test('control: the scanned population really contains in-scope pages', () => {
        // The positive control against REAL product source. The banned shape
        // (a co-mounted <DataTable> with no `fillBody`) has no live instance
        // by construction — that is what this guard enforces — and there is
        // no exemption list here to derive one from. So the positive control
        // is the in-scope population itself: files that would actually ENTER
        // the offender loop rather than `continue` past line 53. 12 measured;
        // floor 4. A walk that returns a big list of the wrong files (or an
        // empty one) reaches zero here while (a) above could still pass.
        //
        // Deliberately does NOT re-declare `stripComments` — a second copy
        // could drift from the one the scan uses. Measured: the stripped and
        // unstripped counts are both 12, so the raw form is sound for a floor.
        let inScope = 0;
        for (const file of walk(APP_ROOT)) {
            const content = fs.readFileSync(file, 'utf-8');
            if (
                /<ListPageShell\.Body\b/.test(content) &&
                /<DataTable\b/.test(content)
            ) {
                inScope++;
            }
        }
        expect(inScope).toBeGreaterThanOrEqual(4);
    });

    test('control: walk() still refuses a missing scan root (#875)', () => {
        // The anti-empty-scan throw lives inside `walk`, so every gut takes
        // it with them: a gutted walk returns [] for a root that does not
        // exist, silently. Asserting the throw from OUTSIDE the function is
        // what keeps that defence reachable.
        expect(() => walk(path.join(APP_ROOT, '__no_such_dir__'))).toThrow(
            /scan root does not exist/,
        );
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
