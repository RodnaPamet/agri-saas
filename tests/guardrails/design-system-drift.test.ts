/**
 * Guardrail: design system anti-drift.
 *
 * Prevents raw Tailwind color utilities from creeping back into pages
 * that have been migrated to the semantic token system. Also detects
 * duplicate button/badge component implementations.
 *
 * Two modes:
 * 1. Migrated pages: strict — no raw slate/gray/neutral color classes allowed
 * 2. All new pages: advisory — should use semantic tokens from the start
 */
import * as fs from 'fs';
import * as path from 'path';

const TENANT_ROUTES_DIR = path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)');
const COMPONENTS_DIR = path.resolve(__dirname, '../../src/components');

/**
 * Pages fully migrated to the design system in Epic 51.
 * These pages must NOT regress to raw color utilities.
 */
const MIGRATED_PAGES = [
    // #12 platform-support console — design-system-native from birth
    // (ListPageShell / DataTable / Modal / Combobox / DatePicker / FormField /
    // StatusBadge / Button + semantic tokens only; no raw colors, no legacy
    // btn/badge). Promoted on arrival rather than parked in the unmigrated
    // tally, so these files carry the raw-colour and legacy-class assertions
    // from day one.
    'admin/promotions/page.tsx',
    'admin/promotions/PromotionsAdminClient.tsx',
    'admin/companies/page.tsx',
    'admin/companies/CompaniesAdminClient.tsx',
    // MECHANISATOR operator screen — design-system-native from birth
    // (Card / Button / Heading / Skeleton + semantic tokens only; no raw
    // colors, no legacy btn/badge).
    'my-work/page.tsx',
    'my-work/MyWorkClient.tsx',
    // EI-1 — Entra provider wizard; design-system-native from birth
    // (Input / FormField / ToggleGroup / Card + semantic tokens only).
    'admin/entra/page.tsx',
    // SP-5 — SharePoint sync-health dashboard; semantic tokens + KPIStat only.
    'admin/integrations/sharepoint-health/page.tsx',
    // RQ-2 — risk appetite config; semantic tokens + Card/Input/Textarea only.
    // RQ-4 — risk scenarios; semantic tokens + Card/Input/Button/StatusBadge only.
    // RQ-5 — risk hierarchy; semantic tokens + Card/Button/Input/ProgressBar only.
    // RQ-6 — KRI dashboard; semantic tokens + Card/Button/Input/StatusBadge only.
    // RQ-8 — correlation matrix; semantic tokens + Card/Button/Input + heat bands.
    // RQ-10 — reports; semantic tokens + Card/Button/StatusBadge only.
    // Field Journal — design-system-native from birth. Server shell +
    // EntityListPage client + EntityDetailLayout detail page; semantic
    // tokens + Card/Button/StatusBadge/Modal/EntityListPage only, no
    // raw color / legacy btn / legacy badge classes.
    'journal/page.tsx',
    'journal/JournalClient.tsx',
    'journal/[id]/page.tsx',
    'dashboard/page.tsx',
    // Epic 69 split the dashboard into a thin server shell + a
    // `'use client'` component owning the card composition. Both
    // sides of the split clean on the design-system checks.
    'dashboard/DashboardClient.tsx',
    'vendors/VendorsClient.tsx',
    'admin/members/page.tsx',
    // Second migration pass — Epic 51 finishing guide. A page is only
    // added here once it is clean on ALL three checks: raw color
    // utilities, legacy `.btn btn-*`, and legacy `.badge badge-*`.
    // Pages that have had their raw colors migrated but still use
    // legacy button/badge CSS are tracked by the raw-color ratchet
    // instead (`tests/guardrails/raw-color-ratchet.test.ts`) — they
    // get promoted here when the component migration also lands.
    'clauses/loading.tsx',
];

const RAW_COLOR_RE = /\b(?:text|bg|border)-(?:slate|gray|neutral|zinc)-\d{2,3}\b/g;

const LEGACY_BTN_RE = /className="btn btn-/g;
const LEGACY_BADGE_RE = /className="badge badge-|className=\{`badge \$/g;

function readFile(...segments: string[]): string {
    return fs.readFileSync(path.join(TENANT_ROUTES_DIR, ...segments), 'utf-8');
}

describe('Migrated page anti-drift', () => {
    it.each(MIGRATED_PAGES)('%s uses no raw Tailwind color utilities', (rel) => {
        const src = readFile(rel);
        const lines = src.split('\n');
        const violations: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('import')) continue;
            // Data-viz segment colors (progress bars, charts) are intentional literal values
            if (/color:\s*['"]bg-/.test(line)) continue;

            for (const m of line.matchAll(RAW_COLOR_RE)) {
                violations.push(`  Line ${i + 1}: "${m[0]}" — use semantic token instead`);
            }
        }

        expect(violations).toEqual([]);
    });

    it.each(MIGRATED_PAGES)('%s uses no legacy .btn CSS classes', (rel) => {
        const src = readFile(rel);
        expect(src).not.toMatch(LEGACY_BTN_RE);
    });

    it.each(MIGRATED_PAGES)('%s uses no legacy .badge CSS classes', (rel) => {
        const src = readFile(rel);
        expect(src).not.toMatch(LEGACY_BADGE_RE);
    });
});

describe('Duplicate implementation detector', () => {
    function findComponentFiles(dir: string, acc: string[] = []): string[] {
        if (!fs.existsSync(dir)) return acc;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) findComponentFiles(full, acc);
            else if (entry.name.endsWith('.tsx')) acc.push(full);
        }
        return acc;
    }

    const componentFiles = findComponentFiles(COMPONENTS_DIR);

    it('only one Button component exists (src/components/ui/button.tsx)', () => {
        const buttonFiles = componentFiles.filter(f => {
            const base = path.basename(f).toLowerCase();
            return (base === 'button.tsx' || base === 'btn.tsx' || base === 'appbutton.tsx')
                && !f.includes('node_modules');
        });
        const rel = buttonFiles.map(f => path.relative(COMPONENTS_DIR, f).replace(/\\/g, '/'));
        expect(rel).toEqual(['ui/button.tsx']);
    });

    it('only one StatusBadge component exists (src/components/ui/status-badge.tsx)', () => {
        const badgeFiles = componentFiles.filter(f => {
            const base = path.basename(f).toLowerCase();
            return (base === 'status-badge.tsx' || base === 'statusbadge.tsx')
                && !f.includes('node_modules');
        });
        const rel = badgeFiles.map(f => path.relative(COMPONENTS_DIR, f).replace(/\\/g, '/'));
        expect(rel).toEqual(['ui/status-badge.tsx']);
    });

    it('only one EmptyState component exists (src/components/ui/empty-state.tsx)', () => {
        const emptyFiles = componentFiles.filter(f => {
            const base = path.basename(f).toLowerCase();
            return (base === 'empty-state.tsx' || base === 'emptystate.tsx')
                && !f.includes('node_modules');
        });
        const rel = emptyFiles.map(f => path.relative(COMPONENTS_DIR, f).replace(/\\/g, '/'));
        expect(rel).toEqual(['ui/empty-state.tsx']);
    });

    it('no parallel CVA button definitions outside ui/button.tsx', () => {
        const violations: string[] = [];
        for (const f of componentFiles) {
            if (f.endsWith('button.tsx') && f.includes(path.join('ui', 'button.tsx'))) continue;
            const content = fs.readFileSync(f, 'utf-8');
            if (/\bcva\b.*variant/.test(content) && /button/i.test(path.basename(f))) {
                violations.push(path.relative(COMPONENTS_DIR, f).replace(/\\/g, '/'));
            }
        }
        expect(violations).toEqual([]);
    });
});

describe('New page token discipline', () => {
    function findPageFiles(dir: string, acc: string[] = []): string[] {
        if (!fs.existsSync(dir)) return acc;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) findPageFiles(full, acc);
            else if (entry.name === 'page.tsx' || entry.name.endsWith('Client.tsx') || entry.name.endsWith('Browser.tsx')) {
                acc.push(full);
            }
        }
        return acc;
    }

    const allPages = findPageFiles(TENANT_ROUTES_DIR);
    const migratedSet = new Set(MIGRATED_PAGES);

    const unmigrated = allPages.filter(f => {
        const rel = path.relative(TENANT_ROUTES_DIR, f).replace(/\\/g, '/');
        return !migratedSet.has(rel);
    });

    it('tracks unmigrated page count (should decrease over time)', () => {
        // Cap history:
        //   - 85: pre-Epic-49 baseline.
        //   - 87 (+2): Epic 49 added /calendar/page.tsx +
        //     /calendar/CalendarClient.tsx, both leaning on legacy
        //     `btn btn-*` + `glass-card` classes for header chrome.
        //   - 88 (+1): Epic 66 added the frameworks client island
        //     view toggle. Uses one `glass-card` class for the empty
        //     state — bounded follow-up to migrate alongside the
        //     other Epic 66 polish surfaces.
        //   - 92 (+4): Epic G-3 added the vendor-questionnaire
        //     builder admin surface — admin/vendor-templates/page.tsx,
        //     VendorTemplatesIndexClient.tsx, [templateId]/page.tsx,
        //     and [templateId]/VendorTemplateBuilderClient.tsx. Uses
        //     `glass-card` + a small set of legacy `btn` / `badge`
        //     classes that match the rest of the admin surface.
        //     Bounded follow-up to migrate alongside the other admin
        //     pages.
        //   - 94 (+2): Epic G-3 prompt 7 added the reviewer page —
        //     admin/vendor-assessment-reviews/[assessmentId]/page.tsx
        //     + VendorAssessmentReviewClient.tsx. Same `glass-card`
        //     + legacy `btn` / `badge` shape as the rest of the
        //     admin surface; bounded follow-up.
        //   - 98 (+4): Epic G-4 added the access-reviews surface —
        //     access-reviews/page.tsx + AccessReviewsClient.tsx +
        //     access-reviews/[reviewId]/page.tsx +
        //     AccessReviewDetailClient.tsx. The pages already use
        //     token classes (text-content-*, bg-bg-*, ProgressBar,
        //     StatusBadge) so they don't actually trip the
        //     raw-color/btn/badge checks — they're listed in the
        //     unmigrated tally only because they aren't yet in
        //     `MIGRATED_PAGES` (promotion is a separate landing).
        //     Bounded follow-up promotes them.
        //   - 99 (+1): R13-PR10 — audit log split out of the admin
        //     landing into its own page (admin/audit-log/page.tsx +
        //     AuditLogClient.tsx). The new page uses
        //     PageHeader / ListPageShell / DataTable directly so it
        //     doesn't trip the raw-color/btn/badge checks; it's in
        //     the unmigrated tally only because the surface is new
        //     and not yet listed in MIGRATED_PAGES. Bounded follow-up
        //     promotes it.
        //   - 101 (+2): R25 — Processes canvas (processes/page.tsx +
        //     ProcessesClient.tsx). The pages use WorkspaceShell +
        //     ProcessCanvas; token-only classes throughout. Listed
        //     in the unmigrated tally only because the surface is
        //     new and not yet promoted to MIGRATED_PAGES. The
        //     promotion is a separate landing per the documented
        //     convention.
        //   - 103 (+2): Modal-form follow-up — assets/new/page.tsx +
        //     audits/new/page.tsx redirect shims for the create-flow
        //     modal migrations. Each is a one-liner
        //     `redirect(`/t/${tenantSlug}/<entity>?create=1`)` —
        //     no UI classes at all, but Next requires a page.tsx at
        //     the segment. Listed in the unmigrated tally only
        //     because the surfaces are new and not yet promoted to
        //     MIGRATED_PAGES; promotion is a separate landing.
        //   - 104 (+1): VR-10 — processes/governance/page.tsx, the
        //     cross-map governance graph. Token-clean (no raw colour
        //     utilities — uses content-*/border-*/bg-* tokens + health
        //     ring tokens); in the unmigrated tally only because the
        //     surface is new and not yet promoted to MIGRATED_PAGES.
        //     loss-event register (predicted-vs-actual). Token-clean
        //     (content-*/bg-*/border-* semantic tokens only; bars via
        //     <ProgressBar>, date via <DatePicker>); in the unmigrated
        //     tally only because the surface is new and not yet
        //     promoted to MIGRATED_PAGES.
        //     board-altitude view. Token-clean (semantic tokens only,
        //     reuses <Card>/<KPIStat>/<StatusBadge>/<DashboardLayout>);
        //     in the unmigrated tally only because the surface is new
        //     and not yet promoted to MIGRATED_PAGES.
        // Each increment names the epic + page + reason; promotion
        // to MIGRATED_PAGES is the path forward, never silent
        // floor-bumping.
        //   - 109: Feature 1 (spray-prescription map) adds three new
        //     surfaces — locations list (page + LocationsClient island)
        //     and the location detail page. Semantic tokens throughout;
        //     they count as new until promoted to MIGRATED_PAGES.
        //   - 110 (+1): WP-2 module gating — admin/modules/page.tsx, the
        //     per-tenant "simple mode" settings page. Token-clean
        //     (semantic tokens only; uses <Switch>/<Button>/<StatusBadge>/
        //     <Heading>/<PageBreadcrumbs>/cardVariants); in the unmigrated
        //     tally only because the surface is new and not yet promoted
        //     to MIGRATED_PAGES.
        //   - 112 (+2): inventory ledger — inventory/page.tsx shim +
        //     inventory/InventoryClient.tsx (the lots list + ledger
        //     surface). Token-clean (semantic tokens + platform primitives:
        //     DataTable/Modal/Combobox/DatePicker/ToggleGroup/StatusBadge);
        //     new surfaces, not yet promoted to MIGRATED_PAGES.
        //   - 113 (+1): offline operator PWA — field/[taskId]/page.tsx, the
        //     phones-with-gloves field-execution surface. Token-clean
        //     (semantic tokens + Button/StatusBadge/Heading/MapCanvas);
        //     new surface, not yet promoted.
        //   - 115 (+2): farm tasks (#28) — farm-tasks/page.tsx shim +
        //     farm-tasks/FarmTasksClient.tsx, the operator field-work queue
        //     on the IC Task module. Token-clean (semantic tokens +
        //     EntityListPage/DataTable/StatusBadge/Modal); new surfaces,
        //     not yet promoted to MIGRATED_PAGES.
        //   - 118 (+3): knowledge base (#29) — knowledge/page.tsx +
        //     knowledge/KnowledgeClient.tsx + knowledge/[id]/page.tsx, the
        //     versioned-SOP/growing-guide surface (the Policy feature's
        //     twin). Token-clean (semantic tokens + EntityListPage/
        //     EntityDetailLayout/StatusBadge/Modal); new surfaces, not yet
        //     promoted to MIGRATED_PAGES.
        //   - 120 (+2): certification schemes (Certification Reseat) —
        //     schemes/page.tsx shim + schemes/SchemesClient.tsx, the
        //     AG_SCHEME framework catalog surface. Token-clean (semantic
        //     tokens + EntityListPage/DataTable/Modal/FormField/Input/
        //     ProgressBar); new surfaces, not yet promoted to MIGRATED_PAGES.
        //   - 125 (+5, 2026-06-15): crop planning integration —
        //     planning/page.tsx + planning/CropPlansClient.tsx +
        //     planning/[cropPlanId]/page.tsx + planning/seasons/page.tsx +
        //     planning/seasons/SeasonsClient.tsx, the succession-planning
        //     surface (crop plans list + detail board + seasons).
        //     Token-clean (semantic tokens + EntityListPage/
        //     EntityDetailLayout/DataTable/GanttTimeline/Modal/FormField/
        //     Combobox/DatePicker/StatusBadge); new surfaces, not yet
        //     promoted to MIGRATED_PAGES.
        //   - 133 (+8, 2026-06-16): enterprise-grain tenant UI —
        //     grain/layout.tsx gate + the Contracts / Bins / Yield
        //     list surfaces (page + client each) + Costs report
        //     (page + client). Token-clean (semantic tokens +
        //     EntityListPage/DataTable/Modal/FormField/Combobox/
        //     DatePicker/RadioGroup/StatusBadge/ProgressBar/ToggleGroup);
        //     new surfaces, not yet promoted to MIGRATED_PAGES.
        //   - 135 (+2, 2026-06-17): Stock Ledger Integrity admin page —
        //     admin/ledger-integrity/page.tsx + LedgerIntegrityClient.tsx
        //     (the reconciliation status hero + run button + history
        //     table). Token-clean (semantic tokens only: content-*/bg-*/
        //     border-* + Card/Button/DataTable/StatusBadge/InlineNotice/
        //     Heading); new surfaces, not yet promoted to MIGRATED_PAGES.
        //   - 136 (+1, 2026-07-03): Exchange marketplace —
        //     exchange/ExchangeClient.tsx, the cross-tenant P2P map +
        //     synced offer list. Token-clean (semantic tokens only:
        //     content-*/bg-*/border-* + ListPageShell/PageBreadcrumbs/
        //     FilterToolbar/Button/Heading/Sheet); new surface, not yet
        //     promoted to MIGRATED_PAGES.
        //   - 140 (+4, 2026-07-04): Exchange write flows — the create-offer
        //     + express-interest modals (CreateOfferModal / InquiryModal) and
        //     the My-listings / My-interests management views
        //     (MyListingsClient / MyInterestsClient). Token-clean (semantic
        //     tokens only + Modal/FormField/Combobox/RadioGroup/DatePicker/
        //     Textarea/StatusBadge/Button/Heading/ListPageShell); new
        //     surfaces, not yet promoted to MIGRATED_PAGES.
        //   - 141 (+1, #15 Agriculture events): events/page.tsx — the global
        //     upcoming-events feed. Token-clean (semantic tokens only +
        //     Heading/PageBreadcrumbs); new surface, not yet promoted.
        //   - 143 (+2, #14 Climate): climate/page.tsx +
        //     climate/ClimateClient.tsx — the native Open-Meteo weather surface
        //     (current conditions, temperature-trend chart, spray window).
        //     Token-clean (semantic tokens only + Heading/PageBreadcrumbs/
        //     Combobox/StatusBadge/EmptyState/Card/TimeSeriesChart); new
        //     surfaces, not yet promoted to MIGRATED_PAGES.
        //   - 144 (+1, #12 Offers): offers/page.tsx — the global company-
        //     promotions feed. Token-clean (semantic tokens only +
        //     Heading/PageBreadcrumbs/Button/Modal via AskForOfferModal);
        //     new surface, not yet promoted to MIGRATED_PAGES.
        //   - 146 (+2, #13 Farm Risk): farm-risk/page.tsx + FarmRiskClient.tsx
        //     — the per-parcel satellite AI risk page. Token-clean (semantic
        //     tokens only + Heading/PageBreadcrumbs/Combobox/StatusBadge/Modal
        //     via AskInsuranceModal); new surfaces, not yet promoted.
        //   - 147 (+1): knowledge/satellite/page.tsx — the satellite-imagery
        //     explainer (NDVI/NDMI/NDRE/GNDVI/EVI) the map legend "Learn more"
        //     link deep-links into. Token-clean (semantic tokens only +
        //     Heading/PageBreadcrumbs/Button); new surface, not yet promoted.
        //   - 148 (+1, feat/trends-page): trends/page.tsx — the market-price
        //     charts shell (renders TrendsPageClient). Token-clean (thin server
        //     shell, no styling of its own); new surface, not yet promoted.
        //   - 150 (+2, feat/rent-page): rent/page.tsx shim + rent/RentClient.tsx
        //     — the tenant-wide rent roll + lease register (roadmap 3/3). Token-
        //     clean (semantic tokens only + ListPageShell/PageBreadcrumbs/
        //     DataTable/Modal/Combobox/ToggleGroup/DatePicker/StatusBadge/
        //     EmptyState/Heading/Button); new surfaces, not yet promoted.
        //   - 151 (+1, 2026-07-15, feat/news-standalone): news/page.tsx — the
        //     decoupled News destination (News split out of the Trends tabs into
        //     its own nav button + route). Token-clean thin shell (renders
        //     NewsPageClient, which lives under src/components/ so it isn't
        //     scanned); in the tally only because the route surface is new and
        //     not yet promoted to MIGRATED_PAGES.
        // 151 → 152: the new scheme detail page. It is a genuinely NEW route
        // (there was no [schemeKey] page at all — /schemes was a dead end), so
        // it enters the tally the same way every unpromoted route does. It is
        // not drift: the page uses semantic tokens throughout and adopts
        // EntityDetailLayout + MetaStrip + breadcrumbs.
        // 152 → 153: the new /support-schemes page. A genuinely NEW route, so
        // it enters the tally the way every unpromoted route does. Not drift:
        // semantic tokens throughout, EntityListPage, bilingual copy.
        expect(unmigrated.length).toBeLessThanOrEqual(153);
    });

    it('migrated page count is at least 4', () => {
        const existing = MIGRATED_PAGES.filter(rel => {
            try { readFile(rel); return true; } catch { return false; }
        });
        expect(existing.length).toBeGreaterThanOrEqual(4);
    });
});
