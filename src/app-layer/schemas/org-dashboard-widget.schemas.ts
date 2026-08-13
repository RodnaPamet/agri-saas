/**
 * Epic 41 — Configurable Dashboard Widget Engine.
 *
 * Zod schemas for the org-level dashboard widget API. The DB stores
 * widget `config`, `position`, and `size` as JSON; this module is the
 * load-bearing shape contract that decides what payloads the API
 * accepts and what the persisted JSON is allowed to look like.
 *
 * The shape per widget is encoded as a Zod **discriminated union** on
 * `type`. Adding a new widget kind:
 *
 *   1. Add the value to the `OrgDashboardWidgetType` Prisma enum
 *      (migration: ALTER TYPE … ADD VALUE).
 *   2. Add a new variant block in `WidgetConfigSchema` below.
 *   3. Register the renderer in the frontend dispatcher (out of
 *      scope for the backend foundation prompt).
 *
 * Position / size are flat `{x,y}` and `{w,h}` objects for direct
 * compatibility with `react-grid-layout`, the layout primitive the
 * upcoming UI prompts will consume. Bounds are conservative:
 *
 *   - `x`, `y` : 0..47   (0..47 row bands fit inside any reasonable
 *                          dashboard before the user scrolls forever)
 *   - `w`      : 1..12   (12-column grid)
 *   - `h`      : 1..24   (24 rows tall is the practical ceiling)
 *
 * Stricter than the underlying JSON would allow — the wrapper at the
 * API boundary rejects anything outside these bounds before persist.
 */

import { z } from 'zod';

// ─── Position / size ────────────────────────────────────────────────

export const WidgetPositionSchema = z
    .object({
        x: z.number().int().min(0).max(47),
        y: z.number().int().min(0).max(47),
    })
    .strict();

export const WidgetSizeSchema = z
    .object({
        w: z.number().int().min(1).max(12),
        h: z.number().int().min(1).max(24),
    })
    .strict();

export type WidgetPosition = z.infer<typeof WidgetPositionSchema>;
export type WidgetSize = z.infer<typeof WidgetSizeSchema>;

// ─── Per-type chartType + config variants ───────────────────────────
//
// The KPI metric set is locked to the four tiles already on the org
// overview page (StatCardsRow). Adding a new metric is one Zod enum
// extension here + one switch arm in the frontend dispatcher.

const KpiChartType = z.enum([
    'coverage',
    'critical-risks',
    'overdue-evidence',
    'tenants',
]);

const KpiConfigSchema = z
    .object({
        type: z.literal('KPI'),
        chartType: KpiChartType,
        config: z
            .object({
                /** Optional gradient class on the icon halo. Free-form
                 *  string to keep theme tokens in the frontend; the
                 *  Zod check is a sanity bound only. */
                gradient: z.string().min(1).max(80).optional(),
                /** Display format. `percent` shows a `%` suffix. */
                format: z.enum(['number', 'percent']).optional(),
                /** Optional override for the default subtitle. */
                subtitleOverride: z.string().max(160).optional(),
                /**
                 * Epic 41 prompt 5 — trend indicator config.
                 *
                 * `previousValue` enables the auto-compute path on
                 * `<KpiCard>`: the card derives delta + percent from
                 * `(value, previousValue)` and renders ▲/▼ with the
                 * polarity-resolved colour. Edge cases (null,
                 * baseline=0) handled by `computeKpiTrend`.
                 *
                 * `trendPolarity` decides good vs bad:
                 *   - `up-good`   — positive delta is GREEN (default)
                 *   - `down-good` — negative delta is GREEN
                 *   - `neutral`   — direction has no semantic
                 *
                 * Picking the wrong polarity for a given metric
                 * (e.g. tagging critical-risks as `up-good`) renders
                 * a green arrow on a regression — actively
                 * misleading. The picker enforces canonical mappings
                 * for the seven built-in chart variants; admins
                 * editing through the API can override.
                 */
                previousValue: z.number().nullable().optional(),
                trendPolarity: z
                    .enum(['up-good', 'down-good', 'neutral'])
                    .optional(),
            })
            .strict(),
    });

const DonutChartType = z.enum(['rag-distribution']);

const DonutConfigSchema = z.object({
    type: z.literal('DONUT'),
    chartType: DonutChartType,
    config: z
        .object({
            showLegend: z.boolean().optional(),
            /** Optional cap on the number of segments rendered. The
             *  rag-distribution donut already caps at 4 (G/A/R/PENDING);
             *  the bound is here for forward compat. */
            maxSegments: z.number().int().min(2).max(8).optional(),
        })
        .strict(),
});

// GRC teardown phase 2: `risks-open` and `practices-coverage` are gone with
// their models. `risks-open` was ALREADY dead before the teardown — the risk
// register left with the compliance uproot and the dispatcher has carried no
// case for it since, so a widget configured that way rendered a flat zero
// line as though it were measured data.
//
// NOTE for the DB-resident-reference sweep (plan §8d.4): persisted
// `OrgDashboardWidget.chartType` rows may still hold either dead value. They
// need a data migration — rewrite to 'evidence-overdue' or delete the widget
// — not just this enum edit.
const TrendChartType = z.enum(['evidence-overdue']);

const TrendConfigSchema = z.object({
    type: z.literal('TREND'),
    chartType: TrendChartType,
    config: z
        .object({
            /** Days of trend history. The `getPortfolioTrends` usecase
             *  clamps to [1, 365] server-side; this is the user-facing
             *  bound. */
            days: z.number().int().min(7).max(365),
            /** Pen colour token. Mirrors existing TrendCard prop set. */
            colorClassName: z.string().min(1).max(80).optional(),
            /**
             * Epic 41 prompt 5 — optional target line.
             *
             * Renders a dashed reference line at `value` on the
             * y-axis with a small label anchored to the right edge
             * of the plot. The line is presentational only; the
             * threshold colouring of the trend itself stays driven
             * by the series' `colorClassName`.
             *
             * `polarity` is reserved for future use (driving the
             * label colour green/red based on whether the latest
             * point is on the good side of the target). For v1 the
             * label is rendered in `text-content-muted` regardless.
             */
            target: z
                .object({
                    value: z.number(),
                    label: z.string().min(1).max(60).optional(),
                    polarity: z.enum(['above-good', 'below-good']).optional(),
                })
                .strict()
                .optional(),
        })
        .strict(),
});

const TenantListChartType = z.enum(['coverage']);

const TenantListConfigSchema = z.object({
    type: z.literal('TENANT_LIST'),
    chartType: TenantListChartType,
    config: z
        .object({
            /** Sort key for the rendered list. */
            sortBy: z.enum(['rag', 'name', 'coverage']).optional(),
            /** Optional cap on rendered rows. Default = render all. */
            limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
});

const DrilldownCtasChartType = z.enum(['default']);

const DrilldownCtasConfigSchema = z.object({
    type: z.literal('DRILLDOWN_CTAS'),
    chartType: DrilldownCtasChartType,
    config: z
        .object({
            /** Optional subset of CTAs to render. Empty / undefined =
             *  render all.
             *
             *  'risks' left with the risk register; 'practices' left with
             *  GRC teardown phase 2 — its tile linked to the deleted
             *  /org/:slug/practices route. Persisted widget rows may still
             *  hold either value: that is the §8d.4 DB-resident class, and
             *  the pre-flight (§8g) found ZERO OrgDashboardWidget rows on
             *  production, so no data migration is required for this stack. */
            entries: z
                .array(z.enum(['evidence']))
                .min(1)
                .max(1)
                .optional(),
        })
        .strict(),
});

/**
 * The widget shape contract. Discriminated on `type`; each variant
 * locks `chartType` and `config` together. Reject-by-default for any
 * combination not enumerated here.
 */
export const WidgetTypedShapeSchema = z.discriminatedUnion('type', [
    KpiConfigSchema,
    DonutConfigSchema,
    TrendConfigSchema,
    TenantListConfigSchema,
    DrilldownCtasConfigSchema,
]);
export type WidgetTypedShape = z.infer<typeof WidgetTypedShapeSchema>;

// ─── Create / update inputs ─────────────────────────────────────────

const CommonShape = z.object({
    title: z.string().min(1).max(120).nullable().optional(),
    position: WidgetPositionSchema,
    size: WidgetSizeSchema,
    enabled: z.boolean().optional(),
});

/**
 * POST body — full create. The discriminated typed shape is `.and()`'d
 * with the layout fields so the union narrowing on `type` still works
 * downstream and we can read `shape.type` / `shape.chartType` /
 * `shape.config` after parse.
 */
export const CreateOrgDashboardWidgetInput = z.intersection(
    WidgetTypedShapeSchema,
    CommonShape,
);
export type CreateOrgDashboardWidgetInput = z.infer<
    typeof CreateOrgDashboardWidgetInput
>;

/**
 * PATCH body — partial update. The widget's `type` is immutable
 * (changing the type is delete + recreate by design). `chartType` and
 * `config` move together because the discriminator constrains them
 * jointly; if either is provided the OTHER must be too. Layout fields
 * are independently updatable.
 */
export const UpdateOrgDashboardWidgetInput = z
    .object({
        title: z.string().min(1).max(120).nullable().optional(),
        position: WidgetPositionSchema.optional(),
        size: WidgetSizeSchema.optional(),
        enabled: z.boolean().optional(),
        // chartType + config update together; reuse the typed shape
        // schema by stripping `type` so the caller doesn't have to
        // re-state it.
        chartType: z.string().min(1).max(80).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        const hasChartType = value.chartType !== undefined;
        const hasConfig = value.config !== undefined;
        if (hasChartType !== hasConfig) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: hasChartType ? ['config'] : ['chartType'],
                message:
                    'chartType and config must be updated together — they are jointly validated by the widget type contract',
            });
        }
    });
export type UpdateOrgDashboardWidgetInput = z.infer<
    typeof UpdateOrgDashboardWidgetInput
>;

// ─── Output DTO ─────────────────────────────────────────────────────

import type { OrgDashboardWidgetType } from '@prisma/client';

export interface OrgDashboardWidgetDto {
    id: string;
    organizationId: string;
    type: OrgDashboardWidgetType;
    chartType: string;
    title: string | null;
    config: Record<string, unknown>;
    position: WidgetPosition;
    size: WidgetSize;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

/**
 * Validates a (type, chartType, config) trio against the discriminated
 * union. Used by the usecase on PATCH paths where the inbound shape
 * arrives in two halves (the row's stored `type` from the DB + the
 * caller's new `chartType`/`config`).
 *
 * Throws `ZodError` on shape mismatch — the wrapper turns it into a
 * 400 ApiErrorResponse via the standard handler.
 */
export function assertWidgetTypedShape(input: {
    type: OrgDashboardWidgetType;
    chartType: string;
    config: unknown;
}): WidgetTypedShape {
    return WidgetTypedShapeSchema.parse(input);
}
