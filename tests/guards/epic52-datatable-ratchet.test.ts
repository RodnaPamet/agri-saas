/**
 * Epic 52 — DataTable migration ratchet.
 *
 * Tracks the count of raw `<table>` elements in app pages and ensures it
 * only goes down as we migrate surfaces to `<DataTable>`.
 *
 * Exclusions:
 *   - SoA print view (`reports/soa/print/`) — semantic HTML required for print CSS
 *   - RBAC page (`admin/rbac/`) — server component; DataTable is client-only
 *
 * After migrating a surface, decrease the baseline.
 */
import * as fs from 'fs';
import * as path from 'path';

const APP_PAGES = path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)');

/** Paths that are intentionally excluded from the ratchet. */
const EXCLUDED_PATHS = [
    'reports/soa/print/',  // Print view — raw table is correct for print CSS
    'admin/rbac/',          // Server component — DataTable requires client
];

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

function countRawTables(): { count: number; files: string[] } {
    const allFiles = walk(APP_PAGES);
    const files: string[] = [];
    let count = 0;

    for (const file of allFiles) {
        const rel = path.relative(APP_PAGES, file);
        if (EXCLUDED_PATHS.some(p => rel.startsWith(p))) continue;

        const content = fs.readFileSync(file, 'utf-8');
        const matches = content.match(/<table[\s>]/g);
        if (matches) {
            count += matches.length;
            files.push(`${rel} (${matches.length})`);
        }
    }
    return { count, files };
}

function countDataTableUsages(): number {
    const allFiles = walk(APP_PAGES);
    let count = 0;
    for (const file of allFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        const matches = content.match(/<DataTable[\s/]/g);
        if (matches) count += matches.length;
    }
    return count;
}

describe('Epic 52 — DataTable migration ratchet', () => {
    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `walk` feeds BOTH counters as `for (const file of walk(APP_PAGES))`,
    // so the non-iterable guts (`0` / `false` / `null` / `undefined` / `{}`)
    // throw at the seam and the empty-iterable ones (`[]` / `''` /
    // `new Set()` / `new Map()`) make both loops run zero times. That second
    // direction IS caught today — but only by the `DataTable adoption is
    // growing` floor below, i.e. by a sibling test. The raw-table ratchet
    // itself returns `{ count: 0, files: [] }` and passes. The defence is
    // borrowed, and it is partial: measured 2026-09-19, a `walk` that
    // recursed one level less still returns 25 `<DataTable>` mounts and 3
    // raw-table hits, so BOTH tests stay green on a scan that has stopped
    // reaching `grain/bins/[binId]/`.

    it('control: walk returns the real .tsx tree under the scan root', () => {
        const files = walk(APP_PAGES);
        // Kills `''` / `new Set()` / `new Map()` at the seam instead of
        // letting them read as a zero-length scan.
        expect(Array.isArray(files)).toBe(true);
        // Measured 2026-09-19: 174 `.tsx` files under
        // `src/app/t/[tenantSlug]/(app)`. The floor sits far below that, so
        // ordinary feature PRs never move it.
        expect(files.length).toBeGreaterThan(100);

        const rels = files.map((f) =>
            path.relative(APP_PAGES, f).split(path.sep).join('/'),
        );
        expect(rels.filter((r) => r.startsWith('..'))).toEqual([]);

        // The extension filter is the ONLY exclusion `walk` has, and it must
        // actually bite. Derived rather than named: `.ts` siblings live one
        // level inside the root (8 at that depth, measured —
        // `*/filter-defs.ts`, `calendar/range.ts`, …).
        const tsSiblings = fs
            .readdirSync(APP_PAGES, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .flatMap((d) =>
                fs
                    .readdirSync(path.join(APP_PAGES, d.name), {
                        withFileTypes: true,
                    })
                    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
                    .map((e) => `${d.name}/${e.name}`),
            );
        expect(tsSiblings.length).toBeGreaterThan(3);
        expect(rels.filter((r) => tsSiblings.includes(r))).toEqual([]);
        expect(rels.filter((r) => !r.endsWith('.tsx'))).toEqual([]);

        // RECURSION is the one behaviour a constant return cannot express,
        // and the gut set never tries a partially-recursing walk. The floor
        // is 4 rather than 3 on purpose: measured 2026-09-19 the deepest
        // pages sit exactly four segments down
        // (`grain/bins/[binId]/BinDetailClient.tsx`,
        // `admin/integrations/sharepoint-health/page.tsx`), and a walk
        // truncated at three levels passes both ratchets below.
        expect(
            Math.max(...rels.map((r) => r.split('/').length)),
        ).toBeGreaterThanOrEqual(4);
        // Only two `.tsx` files live at the root itself (`error.tsx`,
        // `layout.tsx`), so a non-recursive walk is a two-file population.
        expect(
            rels.filter((r) => r.split('/').length === 1).length,
        ).toBeLessThan(5);
        // And the page this ratchet actually counts must be reachable.
        expect(rels).toContain('admin/roles/page.tsx');
    });
    /**
     * Baseline: Raw <table> count in app pages (excluding print/server-only).
     * Started at 22 tables across 16 files.
     * After Epic 52 migration batch: reduced to target below.
     * Lower this number whenever you migrate a surface.
     */
    const RAW_TABLE_BASELINE = 13; // admin/members(2), admin/roles(2), practices/[practiceId](3), tasks/[taskId](1), vendors/[vendorId](3), reports/soa/SoAClient(1) — admin/api-keys migrated to DataTable in the finishing pass; access-reviews/[reviewId]/AccessReviewDetailClient(1) — Epic G-4 master/detail with inline decision practices (same shape as AuditsClient, also excluded by table-platform-drift)

    // `countRawTables` is where the teeth are missing. It is consumed as
    //     const { count, files } = countRawTables();
    //     if (count > RAW_TABLE_BASELINE) fail(...)
    // so SEVEN of the nine guts survive: `0` / `''` / `false` / `[]` / `{}` /
    // `new Set()` / `new Map()` each destructure `count` to `undefined`, and
    // `undefined > RAW_TABLE_BASELINE` is false. Only `null` and `undefined`
    // are caught, and not by an assertion — destructuring them throws. No
    // test in this file ever `expect`s `count`, and `files` is read only to
    // build the failure message, so "3 raw tables across 2 files" and "the
    // counter returned nothing" are the same green.
    it('control: countRawTables returns a real, shaped count of real files', () => {
        const { count, files } = countRawTables();
        // Shape first: every one of the seven survivors lands here as
        // `undefined`, which the ratchet's `>` silently accepts.
        expect(typeof count).toBe('number');
        expect(Array.isArray(files)).toBe(true);

        // Recompute the inventory independently of the helper, so the floor
        // is DERIVED and cannot go stale as surfaces migrate. Measured
        // 2026-09-19: 3 matches across 2 files — `admin/members/page.tsx` (1)
        // and `admin/roles/page.tsx` (2).
        const expected = walk(APP_PAGES)
            .map((f) => path.relative(APP_PAGES, f).split(path.sep).join('/'))
            .filter((rel) => !EXCLUDED_PATHS.some((p) => rel.startsWith(p)))
            .filter((rel) =>
                /<table[\s>]/.test(
                    fs.readFileSync(path.join(APP_PAGES, rel), 'utf-8'),
                ),
            );
        expect(expected.length).toBeGreaterThan(0);
        expect(count).toBeGreaterThanOrEqual(expected.length);
        expect(files.length).toBe(expected.length);
    });

    it('control: the EXCLUDED_PATHS carve-out bites, and bites only what it names', () => {
        // Positive control from real product source: `admin/rbac/page.tsx`
        // genuinely renders `<table className="data-table">` (line 110,
        // measured 2026-09-19) and is the reason the `admin/rbac/` entry
        // exists. If the exclusion stopped working the count would rise; if
        // the scan stopped opening files this assertion would fail.
        const rbac = path.join(APP_PAGES, 'admin/rbac/page.tsx');
        expect(fs.existsSync(rbac)).toBe(true);
        expect(fs.readFileSync(rbac, 'utf-8')).toMatch(/<table[\s>]/);

        const { files } = countRawTables();
        expect(files.some((f) => f.startsWith('admin/rbac/'))).toBe(false);
        // The inclusion half, or a blanket-true exclusion would pass too:
        // `admin/roles/page.tsx` carries the one LIVE raw `<table>` left
        // under this ratchet (line 120) and is NOT exempt.
        expect(files.some((f) => f.startsWith('admin/roles/'))).toBe(true);

        // At least one carve-out must resolve to something real. Stated
        // rather than asserted per-entry because `reports/soa/print/` is
        // already DEAD — `(app)/reports` does not exist (measured
        // 2026-09-19), which also makes the first half of the
        // `excluded paths still use semantic tables` test below vacuous:
        // it is wrapped in `if (fs.existsSync(soaPrint))`.
        expect(
            EXCLUDED_PATHS.filter((p) => fs.existsSync(path.join(APP_PAGES, p)))
                .length,
        ).toBeGreaterThan(0);
    });

    it('raw <table> count does not exceed the baseline', () => {
        const { count, files } = countRawTables();
        if (count > RAW_TABLE_BASELINE) {
            fail(
                `Raw <table> count (${count}) exceeds baseline (${RAW_TABLE_BASELINE}).\n` +
                `Files with raw tables:\n  ${files.join('\n  ')}\n\n` +
                `Migrate to <DataTable> or lower the baseline if this is an excluded surface.`
            );
        }
    });

    // `countDataTableUsages` is the one selector with real teeth: the
    // `toBeGreaterThanOrEqual(15)` below kills all nine guts (`0` fails
    // numerically; the other eight are not numbers, so jest's
    // `ensureNumbers` throws). That floor is also the ONLY thing that
    // reddens this file when `walk` is gutted — do not remove it as
    // redundant. What it cannot see is the direction the tool never tries:
    // a constant, or a silently narrowed source that still clears 15.
    // Measured 2026-09-19: 26 mounts across 23 files, so the counter could
    // lose eleven and stay green.
    it('control: countDataTableUsages counts real mounts in real files', () => {
        const count = countDataTableUsages();
        expect(typeof count).toBe('number');
        // Derived, not typed, so it tracks adoption instead of going stale.
        const mounting = walk(APP_PAGES).filter((f) =>
            /<DataTable[\s/]/.test(fs.readFileSync(f, 'utf-8')),
        );
        expect(mounting.length).toBeGreaterThan(10);
        expect(count).toBeGreaterThanOrEqual(mounting.length);
    });

    it('DataTable adoption is growing', () => {
        const count = countDataTableUsages();
        // After migration batch: should be at least 20 DataTable usages
        expect(count).toBeGreaterThanOrEqual(15);
    });

    it('excluded paths still use semantic tables', () => {
        // Verify the print view and RBAC page still have their expected tables
        const soaPrint = path.join(APP_PAGES, 'reports/soa/print/SoAPrintView.tsx');
        if (fs.existsSync(soaPrint)) {
            expect(fs.readFileSync(soaPrint, 'utf-8')).toContain('<table');
        }
        const rbac = path.join(APP_PAGES, 'admin/rbac/page.tsx');
        if (fs.existsSync(rbac)) {
            expect(fs.readFileSync(rbac, 'utf-8')).toContain('<table');
        }
    });
});
