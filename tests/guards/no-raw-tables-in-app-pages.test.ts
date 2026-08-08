/**
 * Roadmap-10 PR-3 — raw `<table>` ban in app pages.
 *
 * Premium products render every record-list through the same primitive.
 * IC's table primitive is `DataTable` from `@/components/ui/table`; it
 * carries the unified chrome (hover surface, circular row-select,
 * empty-state, future column-visibility gear). A hand-rolled `<table>`
 * in an app page bypasses every one of those affordances and silently
 * drifts the visual baseline.
 *
 * This ratchet scans `src/app/t/[tenantSlug]/(app)/**` for the literal
 * JSX `<table>` opening tag. Every site is either:
 *
 *   1. A true list of records — migrate to `<DataTable>` (the canonical
 *      pattern across the product after R10-PR1 and R10-PR2).
 *
 *   2. A legitimate exemption — listed in EXEMPTIONS below with a
 *      written reason. Three legitimate shapes exist:
 *        (a) Cross-tab matrix (Resource × Action × Role) — DataTable's
 *            uniform-columns model doesn't fit; sticky-left columns
 *            with dynamic per-role columns is a different primitive.
 *        (b) Detail-page sub-table that pre-dates the canonical
 *            entity-detail layout — the table is densely interleaved
 *            with bespoke actions and migration would change the
 *            interaction model.
 *        (c) Print / PDF-export layouts — wkhtmltopdf-style consumers
 *            need explicit, dense HTML tables; DataTable's JS-driven
 *            sizing doesn't survive print rendering.
 *
 *   3. A new raw `<table>` — fails this test. Either migrate or add
 *      to EXEMPTIONS with a category and a reason.
 *
 * Mirrors `list-page-shell-coverage.test.ts` — same EXEMPTIONS shape,
 * same stale-path check. The two are intentionally distinct: shell
 * coverage gates the layout wrapper, this one gates the primitive
 * choice.
 */
import * as fs from 'fs';
import * as path from 'path';

const APP_ROOT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)',
);

/**
 * Files containing a raw `<table>` element that are intentionally NOT
 * migrating to `<DataTable>`. Each entry is a path relative to
 * APP_ROOT, paired with a one-line reason. Removing a file from this
 * list requires migrating its raw `<table>` to `<DataTable>` (the
 * canonical move) OR confirming the file no longer contains one.
 */
const EXEMPTIONS: Record<string, string> = {
    // ─── (a) Cross-tab matrix — Resource × Action × Role ─────────────
    // Permission-matrix overview. Sticky Resource / Action columns
    // with one dynamic column per role. DataTable's uniform-columns
    // model is the wrong shape for a cross-tab.
    'admin/rbac/page.tsx':
        '(a) cross-tab matrix — Resource × Action × Role',

    // Permission-matrix editor on the role-builder page. Same
    // cross-tab shape as rbac, but with checkboxes per cell.
    'admin/roles/page.tsx':
        '(a) cross-tab matrix — Resource × Action editor',

    // ─── (b) Detail-page sub-tables ──────────────────────────────────
    // (Previously exempt: controls/page.tsx evidence,
    // ControlMappingsTab mappings, vendors/page.tsx assessments +
    // subprocessors. All migrated to <DataTable> in the R10-PR3
    // follow-up PR — no longer exempt; the file references in the
    // sibling test would now offend if not removed.)

    // ─── (c) Print / PDF-export layouts ──────────────────────────────
    // SoA (Statement of Applicability) report — interactive UI
    // version. Bespoke layout matched to the auditor's mental model;
    // not a list-page experience.

    // SoA print view — wkhtmltopdf-style consumer. Needs explicit
    // dense HTML; DataTable's JS-driven sizing doesn't survive print.

    // ─── (a) Cross-tab / comparison tables ───────────────────────────
    // RQ-4 — baseline-vs-scenario VaR comparison: a fixed 4-row × 4-col
    // metric comparison (Metric | Baseline | Scenario | Δ), not a data
    // list. DataTable's uniform-row model is the wrong shape.

    // RQ-8 — NxN risk correlation matrix (cross-tab, risk × risk). Same
    // cross-tab shape as the rbac/roles permission matrices.
};

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, results);
        } else if (entry.name.endsWith('.tsx')) {
            results.push(full);
        }
    }
    return results;
}

const TABLE_TAG_RE = /<table\b/;

/**
 * Strip JS/TS comments so `<table>` references inside doc comments
 * and `//` lines don't false-positive. Imperfect (won't honour
 * strings containing `//`) but fine for the presence-check use case.
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '') // /* ... */
        .replace(/\/\/[^\n]*/g, '');       // // ... eol
}

describe('raw <table> ban in app pages (R10-PR3)', () => {
    test('every raw <table> site is either migrated or listed as an exemption', () => {
        const offenders: string[] = [];
        for (const file of walk(APP_ROOT)) {
            const content = stripComments(fs.readFileSync(file, 'utf-8'));
            if (!TABLE_TAG_RE.test(content)) continue;
            const rel = path
                .relative(APP_ROOT, file)
                .split(path.sep)
                .join('/');
            if (EXEMPTIONS[rel]) continue;
            offenders.push(rel);
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} app page(s) contain a raw <table> without an exemption:\n  ` +
                    offenders.join('\n  ') +
                    '\n\nFix options:\n' +
                    '  • Migrate the raw <table> to <DataTable> from @/components/ui/table\n' +
                    '    (see R10-PR1/PR2 for the canonical migration pattern).\n' +
                    '  • OR add the file path to EXEMPTIONS in this test with a\n' +
                    '    category prefix ((a) matrix, (b) detail sub-table, (c) print)\n' +
                    '    and a one-line reason.\n',
            );
        }
    });

    test('no exempt entry has a stale path (file moved / deleted / migrated)', () => {
        const stale: string[] = [];
        for (const exemptPath of Object.keys(EXEMPTIONS)) {
            const abs = path.join(APP_ROOT, exemptPath);
            if (!fs.existsSync(abs)) {
                stale.push(`${exemptPath} (file missing)`);
                continue;
            }
            const content = stripComments(fs.readFileSync(abs, 'utf-8'));
            if (!TABLE_TAG_RE.test(content)) {
                stale.push(`${exemptPath} (no <table> remaining — migration done; remove from EXEMPTIONS)`);
            }
        }
        if (stale.length > 0) {
            throw new Error(
                `EXEMPTIONS contains ${stale.length} stale entry/entries:\n  ` +
                    stale.join('\n  ') +
                    '\n\nRemove these entries from the EXEMPTIONS object.',
            );
        }
    });

    test('EXEMPTIONS entries are uniquely-prefixed by category', () => {
        for (const [file, reason] of Object.entries(EXEMPTIONS)) {
            expect(reason).toMatch(/^\((a|b|c)\)\s+\S/);
            expect(file).not.toMatch(/^\//);
            expect(file).not.toMatch(/\\/);
        }
    });
});
