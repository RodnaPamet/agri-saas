/**
 * Farm Dashboard Page — structural tests.
 *
 * The dashboard is a thin server shell (`page.tsx`) that fetches the
 * greeting + session once + a `'use client'` component
 * (`DashboardClient.tsx`) that owns the card composition. After the
 * farm-UI trim the dashboard is intentionally small: the onboarding
 * banner, the "your farm today" ag strip, the open-field-tasks hero,
 * and the recent-activity feed. The compliance-era surfaces (risk /
 * evidence KPI tiles, the compliance-trend charts, and the next-best-
 * action "readiness" card) were removed.
 *
 * Each section is annotated with which file is being inspected so a
 * future cleanup that re-merges the two (or splits further) updates
 * the right helper.
 */

import * as fs from 'fs';
import * as path from 'path';

const DASHBOARD_DIR = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/dashboard',
);
const DASHBOARD_PAGE = path.join(DASHBOARD_DIR, 'page.tsx');
const DASHBOARD_CLIENT = path.join(DASHBOARD_DIR, 'DashboardClient.tsx');

function readPage(): string {
    return fs.readFileSync(DASHBOARD_PAGE, 'utf-8');
}
function readClient(): string {
    return fs.readFileSync(DASHBOARD_CLIENT, 'utf-8');
}
/**
 * Combined view — used by composition / contract assertions that
 * don't care which side of the server/client boundary owns the JSX.
 */
function readAll(): string {
    return `${readPage()}\n${readClient()}`;
}

// ─── Page Structure ────────────────────────────────────────────────

describe('Farm Dashboard Page', () => {
    test('page file exists and is the slim server shell', () => {
        const content = readPage();
        expect(fs.existsSync(DASHBOARD_PAGE)).toBe(true);
        // The shell shouldn't accidentally inline the entire dashboard
        // composition — that defeats the point of the split. Keep it
        // bounded to ~120 lines.
        expect(content.split('\n').length).toBeLessThan(120);
    });

    test('client component exists', () => {
        expect(fs.existsSync(DASHBOARD_CLIENT)).toBe(true);
    });

    test('uses force-dynamic for real-time data', () => {
        expect(readPage()).toContain("dynamic = 'force-dynamic'");
    });

    test('exports async default function (RSC shell)', () => {
        expect(readPage()).toContain('export default async function DashboardPage');
    });

    test('uses tenant context from getTenantCtx', () => {
        expect(readPage()).toContain('getTenantCtx');
    });

    test('no longer fetches compliance KPI / trend payloads', () => {
        // The trimmed farm dashboard doesn't surface KPI tiles or the
        // compliance-trend charts, so the server shell stopped fetching
        // them entirely.
        const content = readPage();
        expect(content).not.toContain('getExecutiveDashboard');
        expect(content).not.toContain('getMetricTrends');
    });
});

// ─── Widget Composition ────────────────────────────────────────────

describe('Dashboard Widget Composition', () => {
    test('dashboard no longer mounts a HeroMetric (masthead hero removed)', () => {
        expect(readClient()).not.toContain('HeroMetric');
    });

    test('renders the "your farm today" ag strip', () => {
        expect(readClient()).toContain('<AgDashboardStrip');
    });

    // The risk + evidence KPI tiles were removed with the compliance
    // surfaces — the farm dashboard mounts no KpiCard.
    test('dashboard no longer mounts a KpiCard', () => {
        expect(readAll()).not.toContain('<KpiCard');
    });

    // The Risk Distribution donut / Evidence Status breakdown are gone.
    test('dashboard no longer renders a DonutChart or StatusBreakdown', () => {
        const content = readAll();
        expect(content).not.toContain('<DonutChart');
        expect(content).not.toContain('<StatusBreakdown');
    });

    // The compliance-trend charts left with their KPIs.
    test('dashboard no longer renders a TrendCard', () => {
        expect(readAll()).not.toContain('<TrendCard');
    });

    // The next-best-action ("readiness") recommendation card was removed.
    test('dashboard no longer renders the NextBestActionCard', () => {
        expect(readAll()).not.toContain('NextBestActionCard');
    });
});

// ─── Layout Sections ───────────────────────────────────────────────

describe('Dashboard Layout Sections', () => {
    // The KPI grid, trend section, Risk Distribution, Evidence Status,
    // Compliance Alerts and the Evidence Expiry calendar were all
    // removed from the dashboard. Forward-guard their section ids so a
    // re-add is a conscious change.
    const removedIds = [
        'kpi-grid',
        'trend-section',
        'risk-distribution',
        'evidence-status',
        'compliance-alerts',
        'expiry-calendar',
    ];

    test.each(removedIds)('section id="%s" removed', (id) => {
        expect(readAll()).not.toContain(`id="${id}"`);
    });
});

// ─── Server/Client Boundary ────────────────────────────────────────

describe('Dashboard Server/Client Split (Epic 69)', () => {
    test('page.tsx does NOT have "use client" directive (Server Component)', () => {
        const content = readPage();
        expect(content).not.toMatch(/^['"]use client['"]/m);
    });

    test('DashboardClient.tsx DOES have "use client" directive', () => {
        const content = readClient();
        expect(content).toMatch(/^['"]use client['"]/m);
    });

    test('client is a thin composition — no direct data fetching (delegated to child cards)', () => {
        // After the trim the client owns no SWR reads of its own; the ag
        // strip + recent-activity children fetch their own data.
        const content = readClient();
        expect(content).not.toContain('useTenantSWR');
    });

    test('the "Compliance Dashboard" masthead header was removed', () => {
        // The DashboardLayout/PageHeader masthead (title "Compliance
        // Dashboard" + ISO subtitle) is gone; the server greeting header is
        // the sole masthead now.
        const content = readClient();
        expect(content).not.toContain('DashboardLayout');
        expect(content).not.toContain('PageHeader');
    });

    test('page.tsx mounts DashboardClient and no longer forwards a RecentActivityCard', () => {
        const content = readPage();
        expect(content).toContain('<DashboardClient');
        // The recent-activity feed was removed from the dashboard.
        expect(content).not.toContain('RecentActivityCard');
    });
});

// ─── Empty State Handling ──────────────────────────────────────────

describe('Dashboard Empty State Handling', () => {
    // Compliance Alerts was removed from the dashboard — no alerts list
    // and no no-alerts empty state remain.
    test('dashboard no longer renders the Compliance Alerts list', () => {
        const content = readAll();
        expect(content).not.toContain('alerts.length === 0');
    });

    test('UI-15: dashboard no longer renders a notifications bell button', () => {
        // The top-bar notifications bell is the single canonical affordance;
        // the dashboard header no longer shows its own on unread > 0.
        expect(readAll()).not.toContain("href={href('/notifications')}");
    });
});

// ─── Coarse-refresh prohibition (Epic 69 acceptance) ───────────────

describe('Dashboard does not rely on router.refresh()', () => {
    /**
     * Strip block comments + line comments so prose mentions of
     * `router.refresh()` in module docstrings (which describe what
     * the migration moved AWAY from) don't trip the negative
     * assertion. We only want to match real call expressions in
     * executable code.
     */
    function stripComments(src: string): string {
        return src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
    }

    test('neither page.tsx nor DashboardClient.tsx invokes router.refresh()', () => {
        // The Epic 69 acceptance criterion: dashboard freshness
        // flows through SWR cache invalidation, not coarse Next-router
        // refresh. A future PR that introduces `router.refresh()` on
        // this page would defeat the migration.
        const code = stripComments(readPage()) + stripComments(readClient());
        expect(code).not.toMatch(/router\.refresh\s*\(/);
    });
});

// ─── Backward Compatibility ────────────────────────────────────────

describe('Dashboard Backward Compatibility', () => {
    test('loading.tsx still exists', () => {
        expect(fs.existsSync(path.join(DASHBOARD_DIR, 'loading.tsx'))).toBe(true);
    });

    test('recent-activity + low-stock cards were removed from the dashboard', () => {
        // The recent-activity feed and the low-stock card were removed; the
        // ag strip now leads with the AI FieldBriefingCard.
        expect(fs.existsSync(path.join(DASHBOARD_DIR, 'RecentActivityCard.tsx'))).toBe(false);
        expect(fs.existsSync(path.join(DASHBOARD_DIR, 'LowStockCard.tsx'))).toBe(false);
        expect(readPage()).not.toContain('RecentActivityCard');
        expect(fs.existsSync(path.join(DASHBOARD_DIR, 'FieldBriefingCard.tsx'))).toBe(true);
    });

    test('the guided onboarding banner was removed from the dashboard', () => {
        // Per product direction the "set up your farm" onboarding banner no
        // longer renders on the dashboard — the greeting header is the sole
        // masthead. The banner component may still exist for other surfaces;
        // the dashboard client just doesn't mount it.
        expect(readClient()).not.toContain('OnboardingBanner');
    });

    test('client no longer pulls i18n directly (header strings removed)', () => {
        // The only client-side i18n was the masthead title/subtitle, which
        // were removed with the header. Child components own their own copy.
        expect(readClient()).not.toContain('useTranslations');
    });
});
