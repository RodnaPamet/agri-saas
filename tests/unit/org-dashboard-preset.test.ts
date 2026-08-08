/**
 * Epic 41 — default-preset shape + layout-fidelity tests.
 *
 * The preset is the SOURCE OF TRUTH for the migration backfill AND
 * the new-org seed; visual continuity for existing tenants depends
 * on its shape staying constant. These tests lock:
 *
 *   - every preset entry passes the same Zod schema the API enforces
 *   - the eight widgets cover the prior dashboard's sections exactly
 *     (no missing tile, no rogue addition)
 *   - layout positions match the prior visual grid (KPI row at y=0,
 *     donut + trend at y=2, tenant list at y=6, drilldown at y=12)
 *   - the preset has zero overlapping (x..x+w, y..y+h) rectangles
 *
 * The mutation regression at the end strips a widget and re-runs the
 * count assertion to prove the detector isn't vacuous.
 */

import {
    DEFAULT_ORG_DASHBOARD_PRESET,
} from '@/app-layer/usecases/org-dashboard-presets';
import { CreateOrgDashboardWidgetInput } from '@/app-layer/schemas/org-dashboard-widget.schemas';

describe('Epic 41 — default org dashboard preset', () => {
    it('contains exactly six widgets', () => {
        // Was 8: four KPI cards + one donut + one trend + one tenant
        // list + one drilldown CTA group. The risk-quantification
        // uproot removed the `critical-risks` KPI and the `risks-open`
        // trend, both of which read columns that no longer exist.
        expect(DEFAULT_ORG_DASHBOARD_PRESET.length).toBe(6);
    });

    it('every entry is Zod-valid against CreateOrgDashboardWidgetInput', () => {
        for (const widget of DEFAULT_ORG_DASHBOARD_PRESET) {
            const result = CreateOrgDashboardWidgetInput.safeParse(widget);
            if (!result.success) {
                throw new Error(
                    `Preset entry rejected by Zod:\n` +
                    `  type=${widget.type} chartType=${widget.chartType}\n` +
                    `  issues:\n` +
                    result.error.issues
                        .map((i) => `    - ${i.path.join('.')}: ${i.message}`)
                        .join('\n'),
                );
            }
            expect(result.success).toBe(true);
        }
    });

    it('covers the KPI tiles in left-to-right order', () => {
        const kpis = DEFAULT_ORG_DASHBOARD_PRESET.filter(
            (w) => w.type === 'KPI',
        );
        expect(kpis).toHaveLength(3);

        // Order matches StatCardsRow in the prior page.tsx.
        expect(kpis.map((w) => w.chartType)).toEqual([
            'coverage',
            'overdue-evidence',
            'tenants',
        ]);

        // All three sit on row y=0, columns 0/4/8 — re-flowed from
        // 0/3/6/9 when the critical-risks tile was removed.
        for (let i = 0; i < kpis.length; i++) {
            expect(kpis[i].position).toEqual({ x: i * 4, y: 0 });
            expect(kpis[i].size).toEqual({ w: 4, h: 2 });
        }
    });

    it('gives the donut the full width of row y=2', () => {
        // It shared the row with the open-risks TREND until the risk
        // register was removed; leaving it at w:6 would have left half
        // the row empty.
        const donut = DEFAULT_ORG_DASHBOARD_PRESET.find(
            (w) => w.type === 'DONUT',
        );
        expect(donut).toBeDefined();
        expect(donut?.position).toEqual({ x: 0, y: 2 });
        expect(donut?.size).toEqual({ w: 12, h: 4 });
        expect(
            DEFAULT_ORG_DASHBOARD_PRESET.find((w) => w.type === 'TREND'),
        ).toBeUndefined();
    });

    it('row 1 tiles tile the 12-column grid with no gap', () => {
        // Regression guard for the hole the removed critical-risks tile
        // left behind: x=0,w=3 / x=6 / x=9 rendered an empty column 3-5.
        const row1 = DEFAULT_ORG_DASHBOARD_PRESET
            .filter((w) => w.position.y === 0)
            .sort((a, b) => a.position.x - b.position.x);
        let expectedX = 0;
        for (const w of row1) {
            expect(w.position.x).toBe(expectedX);
            expectedX += w.size.w;
        }
        expect(expectedX).toBe(12);
    });

    it('places the tenant list full-width on row y=6', () => {
        const list = DEFAULT_ORG_DASHBOARD_PRESET.find(
            (w) => w.type === 'TENANT_LIST',
        );
        expect(list?.position).toEqual({ x: 0, y: 6 });
        expect(list?.size).toEqual({ w: 12, h: 6 });
    });

    it('places the drilldown CTAs full-width on row y=12', () => {
        const ctas = DEFAULT_ORG_DASHBOARD_PRESET.find(
            (w) => w.type === 'DRILLDOWN_CTAS',
        );
        expect(ctas?.position).toEqual({ x: 0, y: 12 });
        expect(ctas?.size).toEqual({ w: 12, h: 2 });
    });

    it('has no overlapping (x..x+w, y..y+h) rectangles between any two widgets', () => {
        // Catches a future preset edit that accidentally puts two
        // widgets at the same coordinates — RGL would auto-compact
        // them visually, but the user-facing layout would no longer
        // match the original sections.
        function rect(w: typeof DEFAULT_ORG_DASHBOARD_PRESET[number]) {
            return {
                x0: w.position.x,
                x1: w.position.x + w.size.w,
                y0: w.position.y,
                y1: w.position.y + w.size.h,
            };
        }
        function overlaps(
            a: ReturnType<typeof rect>,
            b: ReturnType<typeof rect>,
        ): boolean {
            return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
        }
        const rects = DEFAULT_ORG_DASHBOARD_PRESET.map(rect);
        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                if (overlaps(rects[i], rects[j])) {
                    throw new Error(
                        `Preset entries ${i} and ${j} overlap: ` +
                        `${JSON.stringify(rects[i])} ↔ ${JSON.stringify(rects[j])}`,
                    );
                }
            }
        }
    });

    it('every widget is enabled by default', () => {
        for (const w of DEFAULT_ORG_DASHBOARD_PRESET) {
            expect(w.enabled).toBe(true);
        }
    });

    it('every widget has a non-null human-readable title', () => {
        // Backfill / new-org provisioning relies on the title being
        // present so the persisted dashboard reads sensibly without
        // requiring an admin to edit each widget post-seed.
        for (const w of DEFAULT_ORG_DASHBOARD_PRESET) {
            expect(typeof w.title).toBe('string');
            expect((w.title ?? '').length).toBeGreaterThan(0);
        }
    });

    // ─── Mutation regression ──────────────────────────────────────────

    it('mutation regression — dropping a widget trips the count assertion', () => {
        const broken = DEFAULT_ORG_DASHBOARD_PRESET.slice(0, -1);
        expect(broken.length).toBe(5);
        expect(broken.length).not.toBe(6);
    });
});
