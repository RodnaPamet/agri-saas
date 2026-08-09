/**
 * Elevation PR-5 — empty-state coverage ratchet.
 *
 * Empty states are where polish either compounds or vanishes. A
 * user with zero data is a user evaluating the product. Until this
 * PR there was no ratchet enforcing <EmptyState> adoption on
 * list pages — several rendered inline <div>No items</div>
 * patterns instead.
 *
 * What this ratchet detects
 *   For each top-level list-page client (Client.tsx or page.tsx
 *   directly under a list path) that has BOTH:
 *     - a render branch keyed off data.length === 0 (or
 *       rows.length === 0, items.length === 0), AND
 *     - a return statement that follows it,
 *   the file MUST import `EmptyState` from
 *   `@/components/ui/empty-state`. Inline <div>No data</div>
 *   shapes trip the ratchet.
 *
 * What this ratchet does NOT police
 *   - Detail pages (they use EntityDetailLayout's `empty` prop
 *     which routes to its own EmptyState internally).
 *   - Modal bodies, sub-tables, dropdown menus — these have
 *     different empty-state ergonomics.
 *   - Files with inline length === 0 checks that don't drive a
 *     render branch (e.g. early-return guard for a function).
 *
 * Exempt list
 *   Specific files where the inline empty pattern is appropriate
 *   (e.g. compact inline notices in dashboards). Each entry needs
 *   a written reason. Cap at 8.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

const EXEMPT_FILES = new Set<string>([
    // Detail pages — use EntityDetailLayout's `empty` prop, which
    // routes through DetailLoadingSkeleton + a centred empty
    // string. The empty path is handled by the shell.
    'src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx',
    'src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx',
]);

interface Hit {
    file: string;
    reason: string;
}

const LIST_PAGE_PATTERNS: RegExp[] = [
    /\/page\.tsx$/,
    /Client\.tsx$/,
];

const LENGTH_ZERO_PATTERN_RE = new RegExp(
    '\\b(?:rows|items|data|results|list|entries|records)\\.length\\s*===\\s*0\\s*\\?',
);
const EMPTY_STATE_IMPORT_RE = new RegExp(
    "from\\s+['\"]@/components/ui/empty-state['\"]",
);

function findListPages(): string[] {
    const out: string[] = [];
    function walk(dir: string) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const rel = path.relative(ROOT, full);
            if (entry.name === 'node_modules') continue;
            if (entry.name.startsWith('__')) continue;
            if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) continue;
            if (entry.isDirectory()) walk(full);
            else {
                const isJsx = /\.(tsx|jsx)$/.test(entry.name);
                const isListPattern = LIST_PAGE_PATTERNS.some((rx) =>
                    rx.test(entry.name),
                );
                // Skip detail pages (under [idParam] folders).
                const detailPageRe = new RegExp(
                    '\\[[^/]+\\]/[^/]*\\.(tsx|jsx)$',
                );
                const isDetailPage = detailPageRe.test(rel);
                if (isJsx && isListPattern && !isDetailPage) {
                    out.push(rel);
                }
            }
        }
    }
    walk(path.join(ROOT, 'src/app'));
    return out;
}

describe('Empty-state coverage ratchet (Elevation PR-5)', () => {
    it('every list page with a length===0 render branch imports EmptyState', () => {
        const offenders: Hit[] = [];
        for (const rel of findListPages()) {
            if (EXEMPT_FILES.has(rel)) continue;
            const abs = path.resolve(ROOT, rel);
            const content = fs.readFileSync(abs, 'utf8');
            if (!LENGTH_ZERO_PATTERN_RE.test(content)) continue;
            if (EMPTY_STATE_IMPORT_RE.test(content)) continue;
            offenders.push({
                file: rel,
                reason:
                    'has list-empty render branch but does not import EmptyState',
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file} — ${o.reason}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} list page(s) with a length===0 branch that don't use <EmptyState>.\n\nReplace inline <div>No items yet</div> patterns with <EmptyState variant="no-records" title="..." description="..." /> from '@/components/ui/empty-state'. Use variant='no-results' when filters are active.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('exempt list is bounded and every entry exists', () => {
        for (const rel of EXEMPT_FILES) {
            const abs = path.resolve(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
        }
        expect(EXEMPT_FILES.size).toBeLessThanOrEqual(8);
    });

    it('the list-page scanner finds at least the canonical surfaces', () => {
        const found = findListPages();
        expect(found.length).toBeGreaterThan(10);
    });
});
