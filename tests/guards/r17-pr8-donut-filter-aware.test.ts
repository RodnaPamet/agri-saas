/**
 * R17-PR8 — Risk Distribution donut filter-awareness (REMOVED).
 *
 * PR-8 originally made the Risk Distribution donut the first
 * chart-filter consumer: the card reacted to the selected KPI with a
 * focus ring / dim. The Risk Distribution donut has since been removed
 * from the dashboard entirely (along with the Evidence Status, Compliance
 * Alerts, and Evidence Expiry widgets).
 *
 * This file is now a forward-guard: it locks in the removal so a future
 * change that re-introduces the donut is a conscious decision. The generic
 * `ChartFocusWrapper` recipe that PR-8 seeded lives on and is covered by
 * `r17-pr9-charts-filter-aware.test.ts`.
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

describe('R17-PR8 — Risk Distribution donut removed', () => {
    // #2507. Every other assertion in this file is a NEGATION over `SRC`, so
    // all of them pass if the read ever stops landing on the dashboard client
    // — an emptied file, a rename, an extraction. A removal guard has no
    // positive assertion by construction, which is exactly why it needs one
    // written down.
    it('reads the dashboard client it means to — the control the negations need', () => {
        expect(SRC).toContain('export default function DashboardClient');
        // 1,845 bytes today; a floor well under it separates "this file is
        // small" from "this read returned nothing".
        expect(SRC.length).toBeGreaterThan(600);
    });

    it('the RiskDistributionSection no longer exists on the dashboard', () => {
        expect(SRC).not.toMatch(/function\s+RiskDistributionSection/);
        expect(SRC).not.toContain('id="risk-distribution"');
        expect(SRC).not.toContain('id="risk-severity-donut"');
    });

    it('the dashboard no longer mounts a DonutChart', () => {
        expect(SRC).not.toContain('<DonutChart');
    });

    it('the textual "Focused" badge marker stays gone', () => {
        // Carried over from PR-8: the brand ring is the sole focus
        // affordance — no dashboard chart should reintroduce a badge marker.
        expect(SRC).not.toMatch(/data-chart-focus-badge/);
    });
});
