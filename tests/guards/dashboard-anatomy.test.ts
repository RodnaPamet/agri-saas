/**
 * Polish PR-1 — Dashboard architecture ratchet.
 *
 * Asserts that every dashboard page (page.tsx under any
 * dashboard/ directory, or its sibling Client.tsx companion)
 * mounts inside <DashboardLayout>. Before
 * this PR the executive dashboard was the only consumer; the four
 * per-domain dashboards (risks/tasks/practices/vendors) and the tests
 * dashboard each hand-rolled `<div className="space-y-section
 * animate-fadeIn">` + an inline header block. Result: five front
 * doors with five different hands.
 *
 * Why this matters
 *   Dashboards are landing surfaces. Forcing every one through the
 *   same shell means the masthead, KPI rhythm, chart band placement,
 *   and supporting card grid all read as one composition.
 *
 * What this ratchet detects
 *   Any file matching src/app dashboards (page.tsx or *Client.tsx
 *   in the same directory) that:
 *     - renders a `<Heading level={1}>` (treated as a real page),
 *       AND
 *     - does NOT import `DashboardLayout` from
 *       `@/components/layout/DashboardLayout`.
 *
 * Exempt paths
 *   - Files that JUST redirect (no Heading) are exempt by virtue of
 *     not rendering a heading.
 *   - The SSR `dashboard/page.tsx` shell is exempt because it
 *     delegates to `DashboardClient.tsx`.
 *
 * Pairs with:
 *   - src/components/layout/DashboardLayout.tsx (the shell)
 *   - src/components/layout/PageHeader.tsx (the header primitive)
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
    /loading\.tsx$/,
];

// SSR shell that delegates to a client — exempt by virtue of not
// rendering a heading itself, but listed explicitly for clarity.
const EXEMPT_FILES = new Set<string>([
    // Issues dashboard is a redirect page (no UI of its own).
    'src/app/t/[tenantSlug]/(app)/issues/dashboard/page.tsx',
]);

interface Hit {
    file: string;
    reason: string;
}

function findDashboardFiles(): string[] {
    const out: string[] = [];
    function walk(dir: string) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (
                /\.(tsx|jsx)$/.test(entry.name) &&
                !EXEMPT_FILE_PATTERNS.some((rx) => rx.test(entry.name))
            ) {
                const rel = path.relative(ROOT, full);
                // Match files under any dashboard/ directory, plus
                // sibling *Client.tsx files in the same dir.
                if (
                    /\/dashboard\/(page|.*Client)\.(tsx|jsx)$/.test(rel) &&
                    !EXEMPT_FILES.has(rel)
                ) {
                    out.push(rel);
                }
            }
        }
    }
    walk(path.join(ROOT, 'src/app'));
    return out;
}

const HEADING_RE = /<Heading\s+[^>]*level=\{1\}/;
const DASHBOARD_LAYOUT_IMPORT_RE =
    /from\s+['"]@\/components\/layout\/DashboardLayout['"]/;
const DASHBOARD_LAYOUT_USE_RE = /<DashboardLayout\b/;

describe('Dashboard architecture ratchet (Polish PR-1)', () => {
    it('every dashboard page with a level-1 heading mounts inside DashboardLayout', () => {
        const offenders: Hit[] = [];
        for (const rel of findDashboardFiles()) {
            const abs = path.resolve(ROOT, rel);
            const content = fs.readFileSync(abs, 'utf8');
            // No level-1 heading? Treat as redirect / non-page.
            if (!HEADING_RE.test(content)) continue;
            // Check for DashboardLayout import + usage.
            const hasImport = DASHBOARD_LAYOUT_IMPORT_RE.test(content);
            const hasUsage = DASHBOARD_LAYOUT_USE_RE.test(content);
            if (!hasImport || !hasUsage) {
                offenders.push({
                    file: rel,
                    reason: !hasImport
                        ? 'missing DashboardLayout import'
                        : 'imported DashboardLayout but never rendered <DashboardLayout>',
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file} — ${o.reason}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} dashboard file(s) that render <Heading level={1}> but don't mount inside <DashboardLayout>.\n\nEvery dashboard MUST flow through DashboardLayout from '@/components/layout/DashboardLayout' so the masthead / KPI / chart / supporting-card rhythm is consistent across the product.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('exempt list is bounded and every entry exists', () => {
        for (const rel of EXEMPT_FILES) {
            const abs = path.resolve(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
        }
        expect(EXEMPT_FILES.size).toBeLessThanOrEqual(4);
    });
});
