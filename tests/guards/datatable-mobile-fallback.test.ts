/**
 * DataTable mobile-fallback coverage ratchet (P5).
 *
 * A horizontally-scrolling table is unusable on a 390px phone — the single
 * worst mobile-feel bug for a field user (agri-saas users are farmers and
 * traders on rural LTE). `<DataTable>` supports a `mobileFallback` prop that
 * decides the phone (<sm) rendering strategy:
 *
 *   - `mobileFallback="card"`   — each row renders as a full-width tappable
 *     CARD (title + status pill + a few key/value rows), driven by the
 *     `meta.mobileCard` slot descriptors on the columns.
 *   - `mobileFallback="scroll"` — keep the horizontally-scrollable table.
 *     Correct ONLY for genuinely wide numeric grids (yield / cost matrices)
 *     where the columns must be read side-by-side.
 *
 * The prop is OPTIONAL at the type level (default `"scroll"`), so a new list
 * page can silently ship a phone-hostile scrolling table. This ratchet closes
 * that gap: every list-page `<DataTable>` render site under `src/app/**` MUST
 * EXPLICITLY set `mobileFallback`. No implicit default.
 *
 * A "render site" is a file that either:
 *   - renders a `<DataTable ...>` element directly, OR
 *   - imports `@/components/layout/EntityListPage` (whose `table={{ ... }}`
 *     config renders a `<DataTable>` internally).
 *
 * For each non-exempt render site:
 *   - `card`  → the file must also carry `meta.mobileCard` slot descriptors
 *     (`mobileCard`) so the card actually has content.
 *   - `scroll`→ the file must carry a WRITTEN REASON comment mentioning
 *     "scroll" (why this table stays horizontal on a phone).
 *
 * Non-list DataTables (multi-section dashboards, detail-page sub-tables,
 * wizards, sub-components) are curated in `EXEMPTIONS` with a one-line reason.
 * A "no stale exemptions" test keeps that list honest.
 *
 * Sibling ratchets: `tests/guards/list-page-shell-coverage.test.ts` (the
 * viewport-clamp wrapper) and `tests/guards/no-horizontal-drift-patterns.test.ts`
 * (raw-table / negative-margin drift). This one owns the card-vs-scroll axis.
 */
import * as fs from 'fs';
import * as path from 'path';

const APP_ROOT = path.resolve(__dirname, '../../src/app');

// ── Detectors ───────────────────────────────────────────────────────
// `<DataTable\b` matches `<DataTable` / `<DataTable<Row>` / `<DataTable\n`
// but NOT `<SkeletonDataTable` (no `<` immediately before `DataTable`).
const RENDER_SITE_RE = /<DataTable\b|@\/components\/layout\/EntityListPage/;
// Accepts both the JSX prop form (`mobileFallback="card"`) and the
// EntityListPage config-object form (`mobileFallback: 'card'`).
const CARD_RE = /mobileFallback\s*[:=]\s*['"]?card/;
const SCROLL_RE = /mobileFallback\s*[:=]\s*['"]?scroll/;
const MOBILECARD_META_RE = /\bmobileCard\b/;

interface Analysis {
    isRenderSite: boolean;
    hasCard: boolean;
    hasScroll: boolean;
    hasMobileCardMeta: boolean;
    hasScrollReasonComment: boolean;
}

/**
 * Does the source carry a comment mentioning "scroll" (the written reason a
 * table stays horizontally-scrollable on a phone)? Extracts BOTH block
 * comments (`/* … *​/`, including JSX `{/* … *​/}`, multi-line) and `//` line
 * comments, then tests the comment text — so the reason can live in any
 * comment form next to the `mobileFallback="scroll"`.
 */
function hasScrollReasonComment(content: string): boolean {
    const comments: string[] = [];
    const blockRe = /\/\*[\s\S]*?\*\//g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(content)) !== null) comments.push(m[0]);
    for (const line of content.split('\n')) {
        const idx = line.indexOf('//');
        if (idx >= 0) comments.push(line.slice(idx));
    }
    return comments.some((c) => /scroll/i.test(c));
}

/** Analyse a single file's source for the mobile-fallback contract. */
export function analyze(content: string): Analysis {
    return {
        isRenderSite: RENDER_SITE_RE.test(content),
        hasCard: CARD_RE.test(content),
        hasScroll: SCROLL_RE.test(content),
        hasMobileCardMeta: MOBILECARD_META_RE.test(content),
        hasScrollReasonComment: hasScrollReasonComment(content),
    };
}

/** Return the reason a non-exempt render site FAILS, or null if it passes. */
export function violationReason(a: Analysis): string | null {
    if (!a.hasCard && !a.hasScroll) {
        return 'no explicit mobileFallback — add mobileFallback="card" (+ meta.mobileCard on columns) or mobileFallback="scroll" (+ a reason comment)';
    }
    if (a.hasCard && !a.hasMobileCardMeta) {
        return 'mobileFallback="card" but no meta.mobileCard slot descriptors — the card would be empty; tag columns with meta: { mobileCard: { slot: ... } }';
    }
    if (a.hasScroll && !a.hasScrollReasonComment) {
        return 'mobileFallback="scroll" but no written reason comment — add a comment explaining why this table stays horizontally-scrollable on a phone';
    }
    return null;
}

/**
 * Non-list DataTable render sites. Each path is relative to `src/app` and
 * carries a one-line reason. These are dashboards, detail-page sub-tables,
 * wizards, and sub-components where the row-as-card model doesn't apply (or
 * the parent owns the mobile layout).
 */
const EXEMPTIONS: Record<string, string> = {
    // ── Multi-section dashboards / multi-table admin pages ──
    't/[tenantSlug]/(app)/admin/api-keys/page.tsx':
        'multi-table page (active + revoked keys stacked)',
    't/[tenantSlug]/(app)/admin/members/page.tsx':
        'multi-table admin page (members + pending invites) — members table opts into card mode itself',
    't/[tenantSlug]/(app)/admin/notifications/page.tsx':
        'tabbed admin settings (form + fixed 3-row stats table)',
    't/[tenantSlug]/(app)/admin/integrations/page.tsx':
        'multi-section admin page (banner + info card + connections list)',
    't/[tenantSlug]/(app)/admin/billing/BillingEventLog.tsx':
        'sub-component embedded in the billing page (parent owns layout)',
    't/[tenantSlug]/(app)/admin/ledger-integrity/LedgerIntegrityClient.tsx':
        'multi-section admin page (status hero + reconciliation-history table)',
    't/[tenantSlug]/(app)/admin/rbac/MembersTable.tsx':
        'sub-component of the RBAC dashboard (members + permission matrix)',

    // ── Detail-page sub-tables (EntityDetailLayout, not list pages) ──
    't/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx':
        'detail page — DataTable is the inner roster sub-table',
    't/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx':
        'detail page — DataTable is the inner documents sub-table',
    't/[tenantSlug]/(app)/controls/[controlId]/_tabs/EvidenceSubTable.tsx':
        'detail-page sub-table — evidence rows for one control',
    't/[tenantSlug]/(app)/controls/[controlId]/_tabs/ControlMappingsTab.tsx':
        'detail-page sub-table — framework mappings for one control',
    't/[tenantSlug]/(app)/farm-tasks/[taskId]/FarmTaskDetailClient.tsx':
        'detail page — DataTable is the inner links sub-table',
    't/[tenantSlug]/(app)/planning/[cropPlanId]/PlantingBoard.tsx':
        'detail-page sub-table — plantings of one crop plan (succession board)',
    't/[tenantSlug]/(app)/locations/[locationId]/page.tsx':
        'detail page — parcels sub-table (opts into card mode itself, but not a list page)',

    // ── Wizards / browsers ──

    // ── Responsive view-toggle ──
};

// ── File walk ───────────────────────────────────────────────────────
function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            walk(full, results);
        } else if (entry.name.endsWith('.tsx')) {
            results.push(full);
        }
    }
    return results;
}

function relFromApp(abs: string): string {
    return path.relative(APP_ROOT, abs).split(path.sep).join('/');
}

interface Finding extends Analysis {
    relPath: string;
}

function auditRenderSites(): Finding[] {
    return walk(APP_ROOT)
        .map((abs) => ({
            relPath: relFromApp(abs),
            ...analyze(fs.readFileSync(abs, 'utf-8')),
        }))
        .filter((f) => f.isRenderSite);
}

describe('DataTable mobile-fallback coverage ratchet', () => {
    const findings = auditRenderSites();

    test('every list-page DataTable render site explicitly sets mobileFallback', () => {
        const violators: string[] = [];
        for (const f of findings) {
            if (EXEMPTIONS[f.relPath]) continue;
            const reason = violationReason(f);
            if (reason) violators.push(`${f.relPath}\n      → ${reason}`);
        }
        if (violators.length > 0) {
            throw new Error(
                `${violators.length} list-page DataTable render site(s) violate the mobile-fallback contract:\n  ` +
                    violators.join('\n  ') +
                    '\n\nFix options:\n' +
                    '  • Add mobileFallback="card" and tag ~3-5 columns with meta: { mobileCard: { slot: ... } }\n' +
                    "    (see farm-tasks/FarmTasksClient.tsx for the pattern), OR\n" +
                    '  • Add mobileFallback="scroll" + a comment explaining why the table stays horizontal\n' +
                    '    (wide numeric grids only), OR\n' +
                    '  • Add the file to EXEMPTIONS in this test with a one-line reason (non-list DataTable).\n',
            );
        }
    });

    test('no exempt entry is stale (file exists and still renders a DataTable)', () => {
        const stale: string[] = [];
        for (const rel of Object.keys(EXEMPTIONS)) {
            const abs = path.join(APP_ROOT, rel);
            if (!fs.existsSync(abs)) {
                stale.push(`${rel} (file no longer exists)`);
                continue;
            }
            if (!analyze(fs.readFileSync(abs, 'utf-8')).isRenderSite) {
                stale.push(`${rel} (no longer renders a DataTable / EntityListPage)`);
            }
        }
        if (stale.length > 0) {
            throw new Error(
                `EXEMPTIONS has ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} — remove in the same diff:\n  ` +
                    stale.join('\n  '),
            );
        }
    });

    test('coverage floor: card mode is broadly adopted (defence against silent collapse)', () => {
        const cardSites = findings.filter(
            (f) => !EXEMPTIONS[f.relPath] && f.hasCard,
        );
        // Snapshot after the P5 rollout (~30 list pages carry card mode). The
        // floor stops a future refactor from quietly stripping card mode off a
        // batch of pages without this number changing in the same diff.
        expect(cardSites.length).toBeGreaterThanOrEqual(25);
    });

    // ── In-memory mutation self-tests (the detector actually catches things) ──

    test('SELF-TEST: detector flags a render site with no mobileFallback', () => {
        const src = `export const X = () => <DataTable data={rows} columns={cols} />;`;
        const a = analyze(src);
        expect(a.isRenderSite).toBe(true);
        expect(violationReason(a)).toMatch(/no explicit mobileFallback/);
    });

    test('SELF-TEST: card + mobileCard meta passes; card without meta fails', () => {
        const ok = analyze(
            `<DataTable mobileFallback="card" columns={[{ meta: { mobileCard: { slot: 'title' } } }]} />`,
        );
        expect(violationReason(ok)).toBeNull();

        const bad = analyze(`<DataTable mobileFallback="card" columns={cols} />`);
        expect(violationReason(bad)).toMatch(/no meta\.mobileCard/);
    });

    test('SELF-TEST: scroll + reason comment passes; scroll without comment fails', () => {
        const ok = analyze(
            `// wide numeric grid — keep it horizontally scrollable on a phone\n<DataTable mobileFallback="scroll" columns={cols} />`,
        );
        expect(violationReason(ok)).toBeNull();

        const bad = analyze(`<DataTable mobileFallback="scroll" columns={cols} />`);
        expect(violationReason(bad)).toMatch(/no written reason comment/);
    });

    test('SELF-TEST: config-object form (EntityListPage table with mobileFallback card) is recognised', () => {
        const src = `import { EntityListPage } from '@/components/layout/EntityListPage';\nconst cols = [{ meta: { mobileCard: { slot: 'title' } } }];\n<EntityListPage table={{ data, columns: cols, mobileFallback: 'card' }} />`;
        const a = analyze(src);
        expect(a.isRenderSite).toBe(true);
        expect(a.hasCard).toBe(true);
        expect(violationReason(a)).toBeNull();
    });

    test('SELF-TEST: <SkeletonDataTable> is NOT treated as a render site', () => {
        const a = analyze(`<SkeletonDataTable rows={10} cols={8} />`);
        expect(a.isRenderSite).toBe(false);
    });
});
