/**
 * Epic 41 — Configurable Dashboard Widget Engine — Zod schema tests.
 *
 * The schemas in `org-dashboard-widget.schemas.ts` are the load-bearing
 * shape contract for everything stored in `OrgDashboardWidget.config`,
 * `position`, and `size`. The tests below cover:
 *
 *   - WidgetPositionSchema / WidgetSizeSchema bounds
 *   - Per-type discriminated union: every (type, chartType) pair
 *     accepts its valid config and rejects mismatched chartType +
 *     mismatched config shape
 *   - CreateOrgDashboardWidgetInput happy path + missing fields
 *   - UpdateOrgDashboardWidgetInput superRefine that requires
 *     chartType + config to move together
 *   - assertWidgetTypedShape throws on shape mismatch
 */

import {
    WidgetPositionSchema,
    WidgetSizeSchema,
    WidgetTypedShapeSchema,
    CreateOrgDashboardWidgetInput,
    UpdateOrgDashboardWidgetInput,
    assertWidgetTypedShape,
} from '@/app-layer/schemas/org-dashboard-widget.schemas';

describe('Epic 41 — widget Zod schemas', () => {
    // ─── Position / size bounds ────────────────────────────────────

    describe('WidgetPositionSchema', () => {
        it.each([
            [{ x: 0, y: 0 }, true],
            [{ x: 47, y: 47 }, true],
            [{ x: -1, y: 0 }, false],
            [{ x: 0, y: -1 }, false],
            [{ x: 48, y: 0 }, false],
            [{ x: 0, y: 48 }, false],
            [{ x: 1.5, y: 0 }, false],
            [{ x: 0 }, false],
            [{ x: 0, y: 0, z: 1 }, false],
        ])('%j → valid=%s', (input, valid) => {
            expect(WidgetPositionSchema.safeParse(input).success).toBe(valid);
        });
    });

    describe('WidgetSizeSchema', () => {
        it.each([
            [{ w: 1, h: 1 }, true],
            [{ w: 12, h: 24 }, true],
            [{ w: 0, h: 1 }, false],
            [{ w: 13, h: 1 }, false],
            [{ w: 1, h: 25 }, false],
        ])('%j → valid=%s', (input, valid) => {
            expect(WidgetSizeSchema.safeParse(input).success).toBe(valid);
        });
    });

    // ─── Discriminated union per type ──────────────────────────────

    describe('WidgetTypedShapeSchema — KPI', () => {
        const valid = {
            type: 'KPI',
            chartType: 'coverage',
            config: { format: 'percent', gradient: 'from-emerald-500 to-teal-500' },
        };

        it('accepts every canonical KPI chartType', () => {
            for (const chartType of [
                'coverage',
                'critical-risks',
                'overdue-evidence',
                'tenants',
            ]) {
                const r = WidgetTypedShapeSchema.safeParse({
                    ...valid,
                    chartType,
                });
                expect(r.success).toBe(true);
            }
        });

        it('rejects an unknown KPI chartType', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                ...valid,
                chartType: 'made-up-metric',
            });
            expect(r.success).toBe(false);
        });

        it('rejects a stray top-level field on config (strict)', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                ...valid,
                config: { ...valid.config, mysteryField: 1 },
            });
            expect(r.success).toBe(false);
        });
    });

    describe('WidgetTypedShapeSchema — DONUT', () => {
        it('accepts rag-distribution with optional showLegend', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                type: 'DONUT',
                chartType: 'rag-distribution',
                config: { showLegend: true },
            });
            expect(r.success).toBe(true);
        });

        it('rejects an unknown DONUT chartType', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                type: 'DONUT',
                chartType: 'pie',
                config: {},
            });
            expect(r.success).toBe(false);
        });
    });

    describe('WidgetTypedShapeSchema — TREND', () => {
        it('accepts every canonical TREND chartType + days', () => {
            for (const chartType of [
                'risks-open',
                'practices-coverage',
                'evidence-overdue',
            ]) {
                const r = WidgetTypedShapeSchema.safeParse({
                    type: 'TREND',
                    chartType,
                    config: { days: 90 },
                });
                expect(r.success).toBe(true);
            }
        });

        it('rejects days below 7', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                type: 'TREND',
                chartType: 'risks-open',
                config: { days: 6 },
            });
            expect(r.success).toBe(false);
        });

        it('rejects days above 365', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                type: 'TREND',
                chartType: 'risks-open',
                config: { days: 366 },
            });
            expect(r.success).toBe(false);
        });
    });

    describe('WidgetTypedShapeSchema — TENANT_LIST', () => {
        it('accepts coverage chartType with sortBy', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                type: 'TENANT_LIST',
                chartType: 'coverage',
                config: { sortBy: 'rag', limit: 50 },
            });
            expect(r.success).toBe(true);
        });

        it('rejects unknown sortBy', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                type: 'TENANT_LIST',
                chartType: 'coverage',
                config: { sortBy: 'pizza' },
            });
            expect(r.success).toBe(false);
        });
    });

    describe('WidgetTypedShapeSchema — DRILLDOWN_CTAS', () => {
        it('accepts default chartType + entries subset', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                type: 'DRILLDOWN_CTAS',
                chartType: 'default',
                config: { entries: ['practices', 'risks'] },
            });
            expect(r.success).toBe(true);
        });

        it('rejects empty entries array (must be ≥ 1)', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                type: 'DRILLDOWN_CTAS',
                chartType: 'default',
                config: { entries: [] },
            });
            expect(r.success).toBe(false);
        });
    });

    // ─── Epic 41 prompt 5 additions ─────────────────────────────────

    describe('KPI trend indicator config (previousValue + trendPolarity)', () => {
        const base = {
            type: 'KPI' as const,
            chartType: 'coverage' as const,
            config: { format: 'percent' as const },
        };

        it('accepts a previousValue + trendPolarity pair', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                ...base,
                config: {
                    format: 'percent',
                    previousValue: 60,
                    trendPolarity: 'up-good',
                },
            });
            expect(r.success).toBe(true);
        });

        it('accepts every documented polarity value', () => {
            for (const polarity of ['up-good', 'down-good', 'neutral']) {
                const r = WidgetTypedShapeSchema.safeParse({
                    ...base,
                    config: { format: 'number', trendPolarity: polarity },
                });
                expect(r.success).toBe(true);
            }
        });

        it('accepts null for previousValue (baseline missing)', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                ...base,
                config: { format: 'percent', previousValue: null },
            });
            expect(r.success).toBe(true);
        });

        it('rejects an unknown polarity value', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                ...base,
                config: { format: 'number', trendPolarity: 'inverted' },
            });
            expect(r.success).toBe(false);
        });
    });

    describe('TREND target line config', () => {
        const base = {
            type: 'TREND' as const,
            chartType: 'risks-open' as const,
        };

        it('accepts a target with value only', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                ...base,
                config: { days: 30, target: { value: 80 } },
            });
            expect(r.success).toBe(true);
        });

        it('accepts a target with value + label + polarity', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                ...base,
                config: {
                    days: 90,
                    target: {
                        value: 80,
                        label: 'SLA: 80%',
                        polarity: 'above-good',
                    },
                },
            });
            expect(r.success).toBe(true);
        });

        it('rejects target.label longer than 60 chars', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                ...base,
                config: {
                    days: 30,
                    target: { value: 80, label: 'x'.repeat(61) },
                },
            });
            expect(r.success).toBe(false);
        });

        it('rejects target with stray fields (strict)', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                ...base,
                config: {
                    days: 30,
                    target: { value: 80, mysteryField: 1 },
                },
            });
            expect(r.success).toBe(false);
        });

        it('rejects target without value', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                ...base,
                config: { days: 30, target: { label: 'no value' } },
            });
            expect(r.success).toBe(false);
        });
    });

    describe('Cross-type isolation — config from one type rejected on another', () => {
        it('rejects KPI-style config under a DONUT type', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                type: 'DONUT',
                chartType: 'rag-distribution',
                // `format` is a KPI field; not allowed on DONUT (strict).
                config: { format: 'percent' },
            });
            expect(r.success).toBe(false);
        });

        it('rejects TREND-style config (days) under a TENANT_LIST type', () => {
            const r = WidgetTypedShapeSchema.safeParse({
                type: 'TENANT_LIST',
                chartType: 'coverage',
                config: { days: 30 },
            });
            expect(r.success).toBe(false);
        });
    });

    // ─── Create input ───────────────────────────────────────────────

    describe('CreateOrgDashboardWidgetInput', () => {
        const valid = {
            type: 'KPI',
            chartType: 'coverage',
            config: { format: 'percent' },
            title: 'Coverage',
            position: { x: 0, y: 0 },
            size: { w: 3, h: 2 },
        };

        it('accepts a minimal-but-complete payload', () => {
            const r = CreateOrgDashboardWidgetInput.safeParse(valid);
            expect(r.success).toBe(true);
        });

        it('rejects missing position', () => {
            const { position: _omit, ...rest } = valid;
            void _omit;
            const r = CreateOrgDashboardWidgetInput.safeParse(rest);
            expect(r.success).toBe(false);
        });

        it('rejects missing config', () => {
            const { config: _omit, ...rest } = valid;
            void _omit;
            const r = CreateOrgDashboardWidgetInput.safeParse(rest);
            expect(r.success).toBe(false);
        });

        it('accepts an explicit null title', () => {
            const r = CreateOrgDashboardWidgetInput.safeParse({
                ...valid,
                title: null,
            });
            expect(r.success).toBe(true);
        });
    });

    // ─── Update input ───────────────────────────────────────────────

    describe('UpdateOrgDashboardWidgetInput', () => {
        it('accepts a layout-only update (no chartType/config)', () => {
            const r = UpdateOrgDashboardWidgetInput.safeParse({
                position: { x: 1, y: 2 },
                size: { w: 4, h: 3 },
                enabled: true,
            });
            expect(r.success).toBe(true);
        });

        it('accepts chartType + config moved together', () => {
            const r = UpdateOrgDashboardWidgetInput.safeParse({
                chartType: 'critical-risks',
                config: { format: 'number' },
            });
            expect(r.success).toBe(true);
        });

        it('rejects chartType without config', () => {
            const r = UpdateOrgDashboardWidgetInput.safeParse({
                chartType: 'critical-risks',
            });
            expect(r.success).toBe(false);
        });

        it('rejects config without chartType', () => {
            const r = UpdateOrgDashboardWidgetInput.safeParse({
                config: { format: 'number' },
            });
            expect(r.success).toBe(false);
        });

        it('rejects an unknown extra top-level field (strict)', () => {
            const r = UpdateOrgDashboardWidgetInput.safeParse({
                position: { x: 0, y: 0 },
                somethingElse: 'no',
            });
            expect(r.success).toBe(false);
        });
    });

    // ─── assertWidgetTypedShape ────────────────────────────────────

    describe('assertWidgetTypedShape', () => {
        it('returns the parsed shape on a valid combination', () => {
            const result = assertWidgetTypedShape({
                type: 'KPI',
                chartType: 'coverage',
                config: { format: 'percent' },
            });
            expect(result.type).toBe('KPI');
            expect(result.chartType).toBe('coverage');
        });

        it('throws when config is incompatible with the type', () => {
            expect(() =>
                assertWidgetTypedShape({
                    type: 'TREND',
                    chartType: 'risks-open',
                    // missing required `days`
                    config: {},
                }),
            ).toThrow();
        });
    });
});
