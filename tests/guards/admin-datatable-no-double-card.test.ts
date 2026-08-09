/**
 * R13-PR5 — admin DataTables must not double-wrap in `cardVariants`.
 *
 * The `<DataTable>` primitive already renders its own
 * `bg-bg-default rounded-lg border-border-subtle` outer card (see
 * src/components/ui/table/table.tsx ≈ line 615). Wrapping it in an
 * additional `cardVariants({ density: 'none' })` container layers a
 * second card on top — the visible "old pattern" the user flagged
 * in R13: backdrop-blur glass-card outer + DataTable's own rounded
 * border inner. The two cards visually overlap and read as a
 * chunkier, older-looking shell than the Practices list.
 *
 * Rule: in admin + reports pages, every `<DataTable>` mounts
 * WITHOUT being wrapped in `cardVariants(`. Form-style cards that
 * are not tables (e.g. `#create-key-form`, `#invite-form`) are
 * unaffected — the ratchet scans only blocks containing a
 * `<DataTable` start tag.
 *
 * Other surfaces (form cards, dashboard cards) can still use
 * `cardVariants` freely.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_GLOBS = [
    'src/app/t/[tenantSlug]/(app)/admin',
    'src/app/t/[tenantSlug]/(app)/reports',
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

/**
 * Returns the source string with all JS/TS block comments and
 * single-line comments stripped — the ratchet asserts source
 * structure, not commentary about the prior pattern.
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('admin + reports DataTable shell (R13-PR5)', () => {
    it('no admin/reports <DataTable> is wrapped in `cardVariants(`', () => {
        const offenders: Array<{ file: string; line: number; text: string }> = [];

        for (const glob of SCAN_GLOBS) {
            const dir = path.join(ROOT, glob);
            for (const file of walk(dir)) {
                const raw = fs.readFileSync(file, 'utf8');
                const src = stripComments(raw);
                if (!/<DataTable\b/.test(src)) continue;

                // For each `<DataTable` start tag, walk backwards
                // through the file tracking JSX `<div>` /
                // `</div>` balance. When the running counter goes
                // positive, we've located an unclosed `<div>`
                // ancestor of the DataTable. If that ancestor's
                // line contains `cardVariants(`, it's a double-card
                // wrap regardless of how many lines of intermediate
                // column-def / IIFE code sit between the wrapper
                // and the table mount.
                //
                // We climb up to MAX_ANCESTORS levels — three is
                // enough to cover the typical `<ListPageShell.Body>`
                // → `<div>` → `<DataTable>` chain plus form-card
                // siblings on admin dashboards.
                const lines = src.split('\n');
                const MAX_ANCESTORS = 5;
                const MAX_WALK = 400;

                for (let i = 0; i < lines.length; i++) {
                    if (!/<DataTable\b/.test(lines[i]!)) continue;

                    let depth = 0;
                    let foundAncestors = 0;
                    for (
                        let j = i - 1;
                        j >= Math.max(0, i - MAX_WALK) && foundAncestors < MAX_ANCESTORS;
                        j--
                    ) {
                        const line = lines[j]!;
                        const opens = (line.match(/<div\b/g) ?? []).length;
                        const closes = (line.match(/<\/div>/g) ?? []).length;
                        depth += closes - opens;
                        if (depth < 0) {
                            // Hit an unclosed `<div` ancestor on
                            // this line. Inspect it.
                            foundAncestors += 1;
                            if (/cardVariants\(/.test(line)) {
                                offenders.push({
                                    file: path.relative(ROOT, file),
                                    line: j + 1,
                                    text: line.trim().slice(0, 200),
                                });
                                break;
                            }
                            // Reset depth at this level so the next
                            // climb finds the NEXT ancestor.
                            depth = 0;
                        }
                    }
                }
            }
        }

        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} admin/reports <DataTable> wrapped in cardVariants — the primitive renders its own bordered card; an outer card double-stacks it. Drop the wrapper (keep the id on a plain <div> if one is needed for E2E).\n\nOffender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('still finds admin/reports DataTables (sanity — guard is not vacuous)', () => {
        let datatableCount = 0;
        for (const glob of SCAN_GLOBS) {
            const dir = path.join(ROOT, glob);
            for (const file of walk(dir)) {
                const src = fs.readFileSync(file, 'utf8');
                datatableCount += (src.match(/<DataTable\b/g) ?? []).length;
            }
        }
        // 8+ admin DataTables expected (notifications, integrations,
        // api-keys × 2, members × 2, roles, billing event log, rbac
        // members, reports landing).
        expect(datatableCount).toBeGreaterThanOrEqual(8);
    });
});
