/**
 * R17 capstone — Dashboard Reimagined rollout index.
 *
 * Locks the bundled contract for the Roadmap-17 set. Each per-
 * PR ratchet locks the surface it added; this capstone is the
 * INVENTORY — proves the 12 deliverables are still wired up
 * after future refactors, and proves no PR was silently
 * reverted.
 *
 * Roadmap summary:
 *
 *   PR-1 — HeroMetric ambient brand glow (radial wash under
 *          the 72px verdict).
 *   PR-2 — HeroMetric 6s glow breath (gentle opacity drift on
 *          the same gradient).
 *   PR-3 — HeroMetric trend sparkline (token-coloured
 *          trajectory above the delta chip).
 *   PR-4 — MetricCard corner brand glow (200px upper-left
 *          radial wash on KPI tiles).
 *   PR-5 — (deferred) Count-up animation — SSR-hydration risk
 *          larger than the polish payoff; revisit if a future
 *          render boundary lets it land cleanly.
 *   PR-6 — DashboardChartContext (the chart-filter coordination
 *          foundation).
 *   PR-7 — Clickable KPI tiles (the 6 tiles wired into the
 *          context; brand ring + amped glow on the selected
 *          tile).
 *   PR-8 — Risk Distribution donut filter-aware (inline focus
 *          + dim recipe).
 *   PR-9 — Generic ChartFocusWrapper applied to Practice
 *          Coverage + Evidence Status sections.
 *   PR-10 — NextBestActionCard urgency-tinted glow (per
 *           action.id colour token).
 *   PR-11 — "All clear" celebration check on the readiness-
 *           check state.
 *   PR-12 — Dashboard first-paint rise-in (600ms ease-out +
 *           8px translateY-from-below, propagates to all 7
 *           DashboardLayout consumers).
 *   PR-13 — This capstone bundle ratchet + docs.
 *
 * Adding a 14th R17 surface? Append the assertion here, write
 * the per-PR ratchet next to it, and update docs/r17-dashboard-
 * reimagined.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

const HERO_METRIC = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/HeroMetric.tsx'),
    'utf8',
);
const METRIC_CARD = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/MetricCard.tsx'),
    'utf8',
);
const NEXT_BEST = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/NextBestActionCard.tsx'),
    'utf8',
);
const DASHBOARD_CLIENT = fs.readFileSync(
    path.join(
        ROOT,
        'src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx',
    ),
    'utf8',
);
const DASHBOARD_CONTEXT = fs.readFileSync(
    path.join(
        ROOT,
        'src/app/t/[tenantSlug]/(app)/dashboard/DashboardChartContext.tsx',
    ),
    'utf8',
);
const DASHBOARD_LAYOUT = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/DashboardLayout.tsx'),
    'utf8',
);
const TW_CONFIG = fs.readFileSync(
    path.join(ROOT, 'tailwind.config.js'),
    'utf8',
);

describe('R17 capstone — Dashboard Reimagined rollout', () => {
    describe('Masthead — HeroMetric (PR-1..3)', () => {
        it('PR-1: ambient brand glow recipe is wired', () => {
            expect(HERO_METRIC).toMatch(/data-hero-ambient-glow/);
            expect(HERO_METRIC).toMatch(
                /before:bg-\[radial-gradient\(ellipse_640px_400px_at_18%_60%,\s*var\(--brand-subtle\)_0%,\s*transparent_72%\)\]/,
            );
        });

        // R17-PR-2 originally wired a 6s opacity breath. The
        // hero-static-glow PR (2026-05-15) froze the glow at the
        // breath floor (0.65); hero-dimmer-glow (same day) dropped
        // that to 0.15 because the floor still read too bright.
        // This capstone assertion follows the current contract:
        // static opacity at 0.15, no animation utility, no keyframe.
        it('PR-2: glow paints STATICALLY at the dim level (post hero-dimmer-glow)', () => {
            expect(HERO_METRIC).toMatch(/before:opacity-\[0\.15\]/);
            expect(HERO_METRIC).not.toMatch(/before:animate-hero-glow-breath/);
            expect(TW_CONFIG).not.toMatch(/'hero-glow-breath':\s*\{/);
        });

        it('PR-3: sparkline prop + semantic→variant map are present', () => {
            expect(HERO_METRIC).toMatch(/sparkline\?\:\s*SparklineData/);
            expect(HERO_METRIC).toMatch(/SEMANTIC_SPARKLINE_VARIANT/);
            expect(HERO_METRIC).toMatch(/data-hero-metric-sparkline/);
        });
    });

    describe('KPI tiles — MetricCard + KpiCard (PR-4, PR-7)', () => {
        it('PR-4: corner glow recipe is wired', () => {
            expect(METRIC_CARD).toMatch(/data-metric-card-corner-glow/);
            expect(METRIC_CARD).toMatch(
                /before:bg-\[radial-gradient\(circle_200px_at_10%_0%,\s*var\(--brand-subtle\)_0%,\s*transparent_55%\)\]/,
            );
        });

        it('PR-7: chassis supports onClick + selected + a11y semantics', () => {
            expect(METRIC_CARD).toMatch(/onClick\?:\s*\(\)\s*=>\s*void/);
            expect(METRIC_CARD).toMatch(/selected\?\:\s*boolean/);
            expect(METRIC_CARD).toMatch(/role=\{clickable\s*\?\s*['"]button['"]/);
            expect(METRIC_CARD).toMatch(/aria-pressed=\{clickable\s*\?\s*selected/);
        });
    });

    describe('Chart-filter coordination (PR-6, PR-7, PR-8, PR-9)', () => {
        it('PR-6: context exports the canonical surface', () => {
            // Reduced to the farm-app KPI set (risks + evidence) after the
            // compliance KPIs left the dashboard.
            expect(DASHBOARD_CONTEXT).toMatch(
                /export\s+type\s+DashboardKpiKey\s*=[\s\S]*risks[\s\S]*evidence/,
            );
            expect(DASHBOARD_CONTEXT).toMatch(/export\s+function\s+DashboardChartProvider/);
            expect(DASHBOARD_CONTEXT).toMatch(/export\s+function\s+useDashboardChartFilter/);
        });

        // PR-7..PR-9 wired the KPI-tile ↔ chart focus coordination onto
        // the dashboard. That whole surface (KPI grid, trend section,
        // chart-filter provider + wrapper) has since been REMOVED from the
        // farm dashboard. The context primitive (PR-6) survives for other
        // consumers; the dashboard just no longer composes it. These are
        // now forward-guards on the removal.
        it('PR-7: KPI-tile chart wiring removed from the dashboard', () => {
            expect(DASHBOARD_CLIENT).not.toContain('DashboardChartProvider');
            expect(DASHBOARD_CLIENT).not.toContain("click('risks')");
            expect(DASHBOARD_CLIENT).not.toContain("click('evidence')");
        });

        it('PR-8: Risk Distribution donut stays removed from the dashboard', () => {
            expect(DASHBOARD_CLIENT).not.toMatch(/function\s+RiskDistributionSection/);
            expect(DASHBOARD_CLIENT).not.toContain('id="risk-distribution"');
        });

        it('PR-9: ChartFocusWrapper coordination removed from the dashboard', () => {
            expect(DASHBOARD_CLIENT).not.toMatch(/function\s+ChartFocusWrapper/);
            expect(DASHBOARD_CLIENT).not.toContain('<ChartFocusWrapper');
        });
    });

    describe('NextBestActionCard (PR-10, PR-11)', () => {
        it('PR-10: urgency-tinted glow map covers all 5 action.ids', () => {
            expect(NEXT_BEST).toMatch(
                /URGENCY_GLOW_BY_ID:\s*Record<NextBestAction\["id"\],\s*string>/,
            );
            const occurrences = NEXT_BEST.match(
                /before:bg-\[radial-gradient\(circle_240px_at_95%_5%,\s*var\(--[\w-]+\)_0%,\s*transparent_55%\)\]/g,
            );
            expect(occurrences).not.toBeNull();
            expect(occurrences!.length).toBe(5);
        });

        it('PR-11: readiness-check celebration check renders conditionally', () => {
            // Uses the Nucleo `BadgeCheck` — no new lucide-react
            // imports (Roadmap-2 PR-8). The original CheckCircle2
            // attempt was caught by the no-lucide ratchet and
            // swapped to the Nucleo equivalent before merge.
            expect(NEXT_BEST).toMatch(
                /\{action\.id\s*===\s*['"]readiness-check['"]\s*&&\s*\(\s*<BadgeCheck/,
            );
            expect(NEXT_BEST).toMatch(/data-next-best-action-clear-check/);
        });
    });

    describe('First-paint choreography (PR-12)', () => {
        it('PR-12: dashboard-rise-in keyframe + animation + applied to DashboardLayout', () => {
            expect(TW_CONFIG).toMatch(
                /'dashboard-rise-in':\s*\{\s*['"]0%['"]:\s*\{\s*opacity:\s*'0',\s*transform:\s*'translateY\(8px\)'/,
            );
            expect(TW_CONFIG).toMatch(
                /'dashboard-rise-in':\s*\n?\s*'dashboard-rise-in\s+600ms\s+ease-out'/,
            );
            expect(DASHBOARD_LAYOUT).toMatch(/animate-dashboard-rise-in/);
        });
    });
});
