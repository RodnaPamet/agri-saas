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
        if (!fs.existsSync(dir)) {
            throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
        }
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

    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `findDashboardFiles` to a constant and nothing
    // failed. Only the EMPTY-ITERABLE guts survive — `[]`, `''`, `new Set()`,
    // `new Map()` — because the sole call site is
    // `for (const rel of findDashboardFiles())`: zero iterations leaves
    // `offenders` empty, so the `throw` is skipped and `toHaveLength(0)`
    // passes. The non-iterable guts (`0`, `null`, `undefined`, `false`, `{}`)
    // already throw at the for-of, so those were never the gap.
    //
    // Worse than an unasserted population: MEASURED on this tree, none of the
    // three files the collector returns carries `<Heading level={1}>`, so
    // line 101 `continue`s on every one of them and the offender branch has
    // NEVER executed. "Scanned three dashboards, found nothing" and "scanned
    // nothing" were the same green, and so was "the regexes match nothing at
    // all". These controls bracket both seams — one proves the collector sees
    // a real recursive population, one proves its exclusions subtract from
    // that population, one proves the three detector regexes discriminate
    // against real product source. No gut of the collector satisfies all
    // three.
    //
    // MEASURED 2026-09-19 (this worktree): the inline regex matches 4 files
    // under src/app; `findDashboardFiles()` returns 3 after EXEMPT_FILES;
    // deepest result sits 5 segments below src/app; 53 files under src/app
    // match HEADING_RE; exactly 1 file both imports and renders the shell.
    // Every floor below is set far under those numbers so a feature PR that
    // adds, moves or retires a dashboard never has to touch one.
    it('control: findDashboardFiles selects a real, recursive population', () => {
        const files = findDashboardFiles();

        // Floor, not an exact count — 3 today.
        expect(files.length).toBeGreaterThanOrEqual(2);

        for (const rel of files) {
            expect(fs.existsSync(path.resolve(ROOT, rel))).toBe(true);
            expect(rel.startsWith('src/app/')).toBe(true);
            expect(/\.(tsx|jsx)$/.test(rel)).toBe(true);
            expect(rel).toContain('/dashboard/');
        }

        // Recursion is the one behaviour the gut set cannot express. A `walk`
        // that stopped descending would still return `src/app/dashboard/
        // page.tsx` (depth 2) and silently drop the tenant dashboard at
        // `src/app/t/[tenantSlug]/(app)/dashboard/page.tsx` (depth 5).
        // Requiring 3 proves it descended past the first level.
        const deepest = Math.max(
            ...files.map((rel) => rel.split('/').length - 2),
        );
        expect(deepest).toBeGreaterThanOrEqual(3);
    });

    it('control: the exclusion lists subtract from a live selection', () => {
        const files = findDashboardFiles();

        // EXEMPT_FILES — derived from the allowlist itself rather than a
        // hard-coded path, so it cannot go stale. "Absent from the result" is
        // satisfied by an empty result, which is exactly the gutted case;
        // the floor in the control above is what makes this a real
        // subtraction from a non-empty set.
        expect(files.length).toBeGreaterThanOrEqual(2);
        for (const rel of EXEMPT_FILES) {
            expect(fs.existsSync(path.resolve(ROOT, rel))).toBe(true);
            // It sits inside the tree the collector scans and carries the
            // directory the collector keys on — i.e. it is a file the scan
            // WOULD have returned, not a decorative entry.
            expect(rel.startsWith('src/app/')).toBe(true);
            expect(rel).toContain('/dashboard/');
            expect(files).not.toContain(rel);
        }

        // EXEMPT_FILE_PATTERNS — bites on the suffixes it names and spares
        // everything else. Gutted always-`true` the scan returns [] (covered
        // above); gutted always-`false` it would sweep a co-located
        // `DashboardClient.test.tsx` into the population, a direction no
        // value in the gut set can express.
        for (const name of [
            'DashboardClient.test.tsx',
            'DashboardClient.spec.tsx',
            'DashboardClient.stories.tsx',
            'loading.tsx',
        ]) {
            expect(EXEMPT_FILE_PATTERNS.some((rx) => rx.test(name))).toBe(true);
        }
        for (const name of ['DashboardClient.tsx', 'page.tsx']) {
            expect(EXEMPT_FILE_PATTERNS.some((rx) => rx.test(name))).toBe(false);
        }
    });

    it('control: the heading + DashboardLayout detectors discriminate', () => {
        // Nothing the collector returns carries a level-1 heading today, so
        // the offender branch above has never run and these three regexes
        // have never been shown to match anything. Derive the positives from
        // REAL product source rather than a fixture, so a fixture cannot rot
        // into agreement with a broken regex.
        const contents = fs
            .readdirSync(path.join(ROOT, 'src/app'), { recursive: true })
            .map(String)
            .filter((rel) => /\.(tsx|jsx)$/.test(rel))
            .map((rel) => fs.readFileSync(path.join(ROOT, 'src/app', rel), 'utf8'));

        // MEASURED: 53 files under src/app render <Heading level={1}>.
        expect(contents.filter((c) => HEADING_RE.test(c)).length)
            .toBeGreaterThanOrEqual(5);

        // MEASURED: exactly ONE file both imports and renders the shell
        // (src/app/org/[orgSlug]/(app)/PortfolioDashboard.tsx). If this ever
        // reaches zero, the shell this ratchet mandates has no live consumer
        // — that is news, not a guard that should stay green.
        expect(
            contents.filter(
                (c) =>
                    DASHBOARD_LAYOUT_IMPORT_RE.test(c) &&
                    DASHBOARD_LAYOUT_USE_RE.test(c),
            ).length,
        ).toBeGreaterThanOrEqual(1);

        // Near-misses: a level-2 heading, a neighbouring module, and a
        // component whose name merely starts with DashboardLayout must all
        // read as clean.
        expect(HEADING_RE.test('<Heading level={1}>Title</Heading>')).toBe(true);
        expect(HEADING_RE.test('<Heading level={2}>Title</Heading>')).toBe(false);
        expect(
            DASHBOARD_LAYOUT_IMPORT_RE.test(
                "import { DashboardLayout } from '@/components/layout/DashboardLayout';",
            ),
        ).toBe(true);
        expect(
            DASHBOARD_LAYOUT_IMPORT_RE.test(
                "import { X } from '@/components/layout/DashboardLayoutLegacy';",
            ),
        ).toBe(false);
        expect(DASHBOARD_LAYOUT_USE_RE.test('<DashboardLayout\n')).toBe(true);
        expect(DASHBOARD_LAYOUT_USE_RE.test('<DashboardLayoutLegacy>')).toBe(false);
    });

    it('exempt list is bounded and every entry exists', () => {
        for (const rel of EXEMPT_FILES) {
            const abs = path.resolve(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
        }
        expect(EXEMPT_FILES.size).toBeLessThanOrEqual(4);
    });
});
