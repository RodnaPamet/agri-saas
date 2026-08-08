/**
 * PR-A — Dashboard balance + Reports card ratchet.
 *
 *   1. The Evidence Status surface is now a single `<Card>` with a
 *      `<Heading>` + a non-wrapping `<StatusBreakdown>` + an
 *      optional trend mini-chart, matching the Compliance Alerts
 *      card's visual weight. The Card carries the canonical
 *      `id="evidence-status"` E2E selector preserved from the
 *      pre-PR-A composition.
 *
 *   2. The Control Coverage `<ProgressCard>` accepts a `trend`
 *      prop and the dashboard threads the coverage-over-time
 *      series into it.
 *
 *   3. `<ProgressCard>` itself renders the trend slot below the
 *      segment legend (gated on `trend.points.length > 0`) and
 *      uses the shared `<TrendCard>` primitive — no hand-rolled
 *      sparkline.
 *
 *   4. The Reports SoA tab table card uses the canonical
 *      `cardVariants()` density (was `density: 'none'`) so the
 *      table presentation matches the Controls / Risks / Assets
 *      list pages.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('PR-A — dashboard balance + reports card', () => {
    describe('ProgressCard trend slot', () => {
        const src = read('src/components/ui/ProgressCard.tsx');

        it('declares the ProgressCardTrend prop shape', () => {
            expect(src).toMatch(/export interface ProgressCardTrend/);
            expect(src).toMatch(
                /points:\s*ReadonlyArray<\{\s*date:\s*Date;\s*value:\s*number\s*\}>/,
            );
            expect(src).toMatch(/colorClassName:\s*string/);
        });

        it('renders the trend via the shared TrendCard primitive', () => {
            // The trend mini-chart MUST go through TrendCard — a
            // hand-rolled svg+polyline would diverge visually from
            // the Trend section below. Anchor on both the import
            // and the JSX usage in the trend branch.
            expect(src).toMatch(
                /import\s*\{\s*TrendCard\s*\}\s*from\s*['"]@\/components\/ui\/TrendCard['"]/,
            );
            // The JSX usage sits inside the `trend &&
            // trend.points.length > 0` branch.
            expect(src).toMatch(
                /trend &&\s*trend\.points\.length > 0[\s\S]{0,800}<TrendCard\b/,
            );
            // Stable testid lets the dashboard ratchet locate the
            // trend slot without coupling to internal structure.
            expect(src).toMatch(/data-testid="progress-card-trend"/);
        });
    });

    describe('Dashboard adoption (Evidence Status card removed)', () => {
        const src = read(
            'src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx',
        );

        // PR-A gave the dashboard an Evidence Status card (Heading +
        // non-wrapping StatusBreakdown + an evidence-overdue trend
        // mini-chart). That card has since been removed from the dashboard
        // entirely. The ProgressCard primitive's own trend-slot contract is
        // still covered above; these forward-guards lock in the removal.

        it('the Evidence Status card no longer renders on the dashboard', () => {
            expect(src).not.toMatch(/<Card id="evidence-status"/);
            expect(src).not.toContain('id="evidence-status"');
        });

        it('the percent-current + trend mini-chart markers are gone', () => {
            expect(src).not.toContain('data-testid="evidence-status-current-percent"');
            expect(src).not.toContain('data-testid="evidence-status-trend"');
        });

        it('the dashboard no longer imports the status-breakdown primitive', () => {
            expect(src).not.toMatch(
                /from\s*['"]@\/components\/ui\/status-breakdown['"]/,
            );
        });
    });

});
