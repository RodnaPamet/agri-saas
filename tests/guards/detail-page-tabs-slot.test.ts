/**
 * Polish PR-5 — detail-page tab-slot lockdown ratchet.
 *
 * Asserts that no entity detail page imports both `EntityDetailLayout`
 * AND `TabSelect`. Detail-page tab handling MUST flow through
 * `EntityDetailLayout`'s `tabs` prop — that's how every detail page
 * shares the same tab-strip composition (token tone, sticky border,
 * ARIA tablist semantics, count badge slot, disabled state).
 *
 * Why this ratchet
 *   Before this PR, `policies/[policyId]/page.tsx` rendered its tab
 *   strip via a hand-rolled `<TabSelect>` while every other detail
 *   page used `EntityDetailLayout`'s `tabs` slot. The result: a user
 *   crossing detail pages felt the inconsistency, even subliminally.
 *
 * Why TabSelect-without-EntityDetailLayout is fine
 *   `<TabSelect>` is the right primitive for non-detail surfaces —
 *   filter rows on dashboards, report-page sub-views, settings
 *   sub-sections. The ratchet only fires when a detail page uses
 *   BOTH primitives in the same file.
 *
 * Detection
 *   Files matching `src/app/.../[idParam]/page.tsx` (or its
 *   `*Client.tsx` companion) that import both:
 *     - `EntityDetailLayout` from `@/components/layout/EntityDetailLayout`
 *     - `TabSelect` from `@/components/ui/tab-select`
 *   …trip the ratchet. Pages that import only one are fine.
 *
 * Pairs with:
 *   - src/components/layout/EntityDetailLayout.tsx (the shell)
 *   - src/components/ui/meta-strip.tsx (the new meta primitive)
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

const EDL_IMPORT_RE =
    /from\s+['"]@\/components\/layout\/EntityDetailLayout['"]/;
const TAB_SELECT_IMPORT_RE =
    /from\s+['"]@\/components\/ui\/tab-select['"]/;

interface Hit {
    file: string;
}

function findDetailPages(): string[] {
    const out: string[] = [];
    function walk(dir: string) {
        if (!fs.existsSync(dir)) {
            throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const rel = path.relative(ROOT, full);
            if (entry.name === 'node_modules') continue;
            if (entry.name.startsWith('__')) continue;
            if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) continue;
            if (entry.isDirectory()) walk(full);
            else if (
                /\.(tsx|jsx)$/.test(entry.name) &&
                /\[[^/]+\][/].*page\.tsx?$|\[[^/]+\][/].*Client\.tsx?$/.test(rel)
            ) {
                out.push(rel);
            }
        }
    }
    walk(path.join(ROOT, 'src/app'));
    return out;
}

describe('Detail-page tab-slot lockdown (Polish PR-5)', () => {
    it('zero detail-page files import both EntityDetailLayout and TabSelect', () => {
        const offenders: Hit[] = [];
        for (const rel of findDetailPages()) {
            const abs = path.resolve(ROOT, rel);
            const content = fs.readFileSync(abs, 'utf8');
            if (!EDL_IMPORT_RE.test(content)) continue;
            if (!TAB_SELECT_IMPORT_RE.test(content)) continue;
            offenders.push({ file: rel });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} detail-page file(s) importing both EntityDetailLayout AND TabSelect.\n\nDetail-page tab strips MUST flow through EntityDetailLayout's \`tabs\` prop. Pass \`tabs={[...]} activeTab={...} onTabChange={...}\` to the shell and remove the inline <TabSelect>.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('detail-page scan finds at least one detail page', () => {
        // Sanity check — the scanner glob should match real files
        // so a future code reorganisation doesn't silently turn the
        // ratchet into a no-op.
        const found = findDetailPages();
        expect(found.length).toBeGreaterThan(3);
    });
});
