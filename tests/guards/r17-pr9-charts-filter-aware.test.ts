/**
 * R17-PR9 — Extend chart-filter awareness to coverage + evidence.
 *
 * PR-8 made the Risk Distribution donut react to `selectedKpi`.
 * PR-9 extracts the focus-or-dim behaviour into a reusable
 * `ChartFocusWrapper` and applies it to two more sections:
 *
 *   • Practice Coverage (ProgressCard) — focused when
 *     `selectedKpi === 'coverage'`.
 *   • Evidence Status (StatusBreakdown) — focused when
 *     `selectedKpi === 'evidence'`.
 *
 * Three of the six KPI tiles now visually connect to a chart:
 * Risks ↔ donut (PR-8), Coverage ↔ ProgressCard (PR-9), Evidence
 * ↔ StatusBreakdown (PR-9). Tasks / Policies / Findings still
 * dim everything else; their charts arrive in PR-10+ if needed.
 *
 * Six load-bearing invariants:
 *
 *   1. The reusable wrapper exists and reads `selectedKpi` via
 *      `useDashboardChartFilter`. Future chart consumers wire
 *      with one prop (`kpiKey`) — no per-section duplication of
 *      the focus / dim logic.
 *
 *   2. The wrapper computes focus + dim with the same boolean
 *      pattern PR-8 established (`isFocused = selectedKpi ===
 *      kpiKey`, `isDimmed = selectedKpi !== null && !isFocused`).
 *      Drift here desyncs the wrapped sections from
 *      RiskDistributionSection.
 *
 *   3. The wrapper exposes the canonical contract DOM attributes
 *      `data-chart-focus`, `data-chart-dimmed`, AND a new
 *      `data-chart-focus-key=<kpiKey>` so future telemetry / E2E
 *      can identify WHICH chart any DOM node belongs to.
 *
 *   4. The wrapper applies the visual recipe:
 *      `ring-2 ring-brand-default ring-offset-2` on focus, and
 *      `opacity-60` on dim. Same recipe PR-8 used inline.
 *
 *   5. ProgressCard (practice-coverage) is wrapped with
 *      `kpiKey="coverage"`.
 *
 *   6. EvidenceStatusSection is wrapped with `kpiKey="evidence"`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(
    path.join(
        ROOT,
        'src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx',
    ),
    'utf8',
);

// The whole chart-filter coordination surface (KPI tiles ↔ charts) has
// since been REMOVED from the farm dashboard along with the KPI grid, the
// trend section, and the next-best-action card. `ChartFocusWrapper` was
// the shared focus/dim wrapper; with no chart left to wrap, it's gone too.
// This block is now a forward-guard on the removal so a re-add is a
// conscious change.
describe('R17-PR9 — chart-filter coordination removed from dashboard', () => {
    it('no longer defines ChartFocusWrapper on the dashboard', () => {
        expect(SRC).not.toMatch(/function\s+ChartFocusWrapper\b/);
        expect(SRC).not.toContain('<ChartFocusWrapper');
    });

    it('no longer reads selectedKpi via useDashboardChartFilter', () => {
        expect(SRC).not.toContain('useDashboardChartFilter');
    });

    it('no chart-focus contract DOM attributes remain', () => {
        expect(SRC).not.toContain('data-chart-focus');
        expect(SRC).not.toContain('data-chart-dimmed');
        expect(SRC).not.toContain('data-chart-focus-key');
    });

    it('no removed section is still wrapped (risks / evidence / coverage gone)', () => {
        expect(SRC).not.toContain('EvidenceStatusSection');
        expect(SRC).not.toContain('kpiKey=');
    });
});
