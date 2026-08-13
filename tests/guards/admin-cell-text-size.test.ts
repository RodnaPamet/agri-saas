/**
 * R13-PR8 — admin + reports DataTable cells must NOT force
 * `text-xs` on cell content.
 *
 * The `<DataTable>` primitive renders cells at `text-sm leading-6`
 * (see `tableCellClassName` in src/components/ui/table/table.tsx
 * line 54). Cells that wrap their content in
 * `<span className="text-xs …">` shrink the visible text by one
 * size step — the rows read as noticeably smaller than every
 * other list page in the product (Practices / Risks / Policies /
 * Vendors / etc, none of which override text size).
 *
 * Rule: in admin + reports pages, no TanStack column `cell:`
 * renderer may force `text-xs` on its outer wrapper. Inline
 * captions / sub-text (a `<p className="text-xs text-content-subtle">`
 * for a form description, scim-token mono code, billing trial
 * banner sub-text, etc.) are unaffected — the ratchet scans only
 * `cell:` arrow-function bodies.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_GLOBS = [
    'src/app/t/[tenantSlug]/(app)/admin',
];

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(tsx|jsx)$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe('admin + reports DataTable cell text size (R13-PR8)', () => {
    it('no admin/reports DataTable `cell:` renderer forces `text-xs`', () => {
        // Match `cell:` followed by any chars (non-greedy, capped at
        // ~250 chars to keep regex bounded) up to a `text-xs` token.
        // Captures both arrow-function bodies and multi-line cells.
        const pattern = /\bcell\s*:[\s\S]{0,250}?\btext-xs\b/g;

        const offenders: Array<{ file: string; line: number; text: string }> = [];

        for (const glob of SCAN_GLOBS) {
            const dir = path.join(ROOT, glob);
            for (const file of walk(dir)) {
                const src = fs.readFileSync(file, 'utf8');
                const lines = src.split('\n');
                let m: RegExpExecArray | null;
                pattern.lastIndex = 0;
                while ((m = pattern.exec(src)) !== null) {
                    const before = src.slice(0, m.index);
                    const lineNo = before.split('\n').length;
                    offenders.push({
                        file: path.relative(ROOT, file),
                        line: lineNo,
                        text: (lines[lineNo - 1] ?? '').trim().slice(0, 200),
                    });
                }
            }
        }

        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} admin/reports DataTable cell(s) forcing \`text-xs\` — drop the override so cells render at the primitive's default \`text-sm leading-6\` (matches Practices / Risks / etc).\n\nOffender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('still finds DataTable cell renderers (sanity — guard is not vacuous)', () => {
        let cellCount = 0;
        for (const glob of SCAN_GLOBS) {
            const dir = path.join(ROOT, glob);
            for (const file of walk(dir)) {
                const src = fs.readFileSync(file, 'utf8');
                cellCount += (src.match(/\bcell\s*:/g) ?? []).length;
            }
        }
        // ~40+ cell renderers expected across all admin/reports
        // DataTables — sanity floor of 20 keeps the guard
        // mutation-resistant.
        expect(cellCount).toBeGreaterThanOrEqual(20);
    });
});
