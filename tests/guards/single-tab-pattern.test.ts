/**
 * Roadmap-3 PR-8 — single tab pattern across the product.
 *
 * Two tab implementations exist in the codebase:
 *
 *   1. `<EntityDetailLayout>`'s built-in tab bar — the
 *      border-b accent + emphasis-text pattern, used by every
 *      detail page (practices, risks, vendors, audits, etc.).
 *
 *   2. `<TabSelect>` from `@/components/ui/tab-select` — a
 *      pill / underline tab variant. NOT currently used by any
 *      app page (the primitive exists but has zero app-code
 *      consumers).
 *
 * The product effectively has ONE canonical tab style — the
 * EntityDetailLayout pattern. This PR locks that state:
 *
 *   • Confirms `<TabSelect>` has zero consumers in src/app/**.
 *   • Documents the EntityDetailLayout pattern as canonical.
 *   • Future detail pages that want tabs MUST go through
 *     EntityDetailLayout's `tabs` slot, never re-introduce
 *     TabSelect at the page level.
 *
 * What happens to TabSelect itself
 *   It stays as a primitive (the existing rendered tests
 *   exercise it as a harness, and the implementation is
 *   accessibility-rich). It's available if a future use case
 *   genuinely needs the pill variant — but the design DEFAULT
 *   is the EntityDetailLayout pattern.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOT = path.join(ROOT, 'src/app');

const TAB_SELECT_IMPORT_RE =
    /import\s+[^;]*?\bTabSelect\b[^;]*?from\s+['"]@\/components\/ui\/tab-select['"]/;
const TAB_SELECT_MOUNT_RE = /<TabSelect\b/;

interface Hit {
    file: string;
    line: number;
    text: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__')
                continue;
            out.push(...walk(full));
        } else if (/\.(tsx|jsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('Single tab pattern (Roadmap-3 PR-8)', () => {
    it('zero TabSelect imports in app pages', () => {
        const offenders: Hit[] = [];
        for (const file of walk(SCAN_ROOT)) {
            const content = fs.readFileSync(file, 'utf-8');
            if (TAB_SELECT_IMPORT_RE.test(content)) {
                const before = content.match(TAB_SELECT_IMPORT_RE);
                const idx = before ? content.indexOf(before[0]) : 0;
                offenders.push({
                    file: path.relative(ROOT, file),
                    line: content.slice(0, idx).split('\n').length,
                    text: (before?.[0] ?? '').slice(0, 200),
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} TabSelect import(s) in src/app/**.\n\nThe canonical tab pattern is EntityDetailLayout's built-in tab bar (the border-b accent style). TabSelect stays available as a primitive but is NOT the default for app pages. New tab UIs go through EntityDetailLayout's tabs slot.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('zero <TabSelect> mounts in app pages', () => {
        const offenders: Hit[] = [];
        for (const file of walk(SCAN_ROOT)) {
            const content = fs.readFileSync(file, 'utf-8');
            const lines = content.split('\n');
            lines.forEach((line, i) => {
                if (TAB_SELECT_MOUNT_RE.test(line)) {
                    offenders.push({
                        file: path.relative(ROOT, file),
                        line: i + 1,
                        text: line.trim().slice(0, 200),
                    });
                }
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} <TabSelect> mount(s) in src/app/**.\n\nUse <EntityDetailLayout tabs={...}> for detail pages. TabSelect is not the default tab pattern for app pages.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('EntityDetailLayout still owns the canonical tab bar render', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'src/components/layout/EntityDetailLayout.tsx'),
            'utf-8',
        );
        // The canonical tab bar uses `border-b border-border-default`
        // on the nav, the brand accent on the active tab, and the
        // ARIA tablist role.
        expect(src).toMatch(/role=["']tablist["']/);
        expect(src).toMatch(/border-\[var\(--brand-default\)\]/);
        expect(src).toMatch(/border-b/);
    });
});
