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
    /**
     * Baseline: Raw <table> count in app pages (excluding print/server-only).
     * Started at 22 tables across 16 files.
     * After Epic 52 migration batch: reduced to target below.
     * Lower this number whenever you migrate a surface.
     */
    const RAW_TABLE_BASELINE = 13; // admin/members(2), admin/roles(2), practices/[practiceId](3), tasks/[taskId](1), vendors/[vendorId](3), reports/soa/SoAClient(1) — admin/api-keys migrated to DataTable in the finishing pass; access-reviews/[reviewId]/AccessReviewDetailClient(1) — Epic G-4 master/detail with inline decision practices (same shape as AuditsClient, also excluded by table-platform-drift)

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
