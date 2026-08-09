"use client";

/**
 * Epic 41 — `<WidgetPicker>` modal.
 *
 * Production-grade picker for adding new widgets to the org-level
 * dashboard. Built from existing Inflect primitives — Modal,
 * RadioGroup, FormField, Input, NumberStepper — so the visual
 * language matches every other create flow in the app (no bespoke
 * overlay, no one-off form chrome).
 *
 * Flow:
 *
 *   1. Open the modal via `open` / `onOpenChange` (parent practices
 *      lifecycle so the trigger button + the dialog stay decoupled).
 *
 *   2. The user picks a widget TYPE (radio group: KPI / DONUT / TREND /
 *      TENANT_LIST / DRILLDOWN_CTAS).
 *
 *   3. The form re-derives valid CHART VARIANT options + the per-type
 *      CONFIG inputs (e.g. KPI gets `format` + `chartType` choice; TREND
 *      gets a `days` stepper). The variant set + config defaults match
 *      the Zod schema in `org-dashboard-widget.schemas.ts` exactly so
 *      the POST round-trip never 400s on a default value.
 *
 *   4. The user can optionally set a custom TITLE (defaults to a
 *      human-readable label derived from the variant when blank).
 *
 *   5. Submit → caller's `onSubmit(input)` → modal closes on success
 *      and fires `onCreated(widget)` so the parent can append the new
 *      widget to its grid state.
 *
 * The picker does NOT decide where the new widget goes on the grid —
 * `react-grid-layout`'s vertical compactor places new tiles at the
 * top of the dashboard automatically, and the picker emits a default
 * `(x, y)` of `(0, 0)` plus a per-type sensible `(w, h)`. Re-arrange
 * is the existing drag affordance.
 *
 * Errors surface inline via the standard `<FormError>` slot beneath
 * the submit row; the modal stays open so the user can correct the
 * field that failed.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';

import type {
    CreateOrgDashboardWidgetInput,
    OrgDashboardWidgetDto,
    WidgetPosition,
    WidgetSize,
} from '@/app-layer/schemas/org-dashboard-widget.schemas';

// ─── Variant catalogues ─────────────────────────────────────────────
//
// Each catalogue mirrors the Zod discriminated union in
// `org-dashboard-widget.schemas.ts`. A dropdown / stepper / checkbox
// here ALWAYS emits a value the schema accepts — that's the picker's
// load-bearing invariant. If the schema gains a new variant, this
// catalogue is the single edit alongside the renderer's switch arm.

type WidgetTypeKey =
    | 'KPI'
    | 'DONUT'
    | 'TREND'
    | 'TENANT_LIST'
    | 'DRILLDOWN_CTAS';

interface WidgetTypeOption {
    type: WidgetTypeKey;
    /** Default `(w, h)` for newly-created widgets of this type. */
    defaultSize: WidgetSize;
    /** Default chartType for the dropdown initial value. */
    defaultChartType: string;
}

const WIDGET_TYPES: ReadonlyArray<WidgetTypeOption> = [
    {
        type: 'KPI',
        defaultSize: { w: 3, h: 2 },
        defaultChartType: 'coverage',
    },
    {
        type: 'DONUT',
        defaultSize: { w: 4, h: 4 },
        defaultChartType: 'rag-distribution',
    },
    {
        type: 'TREND',
        defaultSize: { w: 6, h: 3 },
        defaultChartType: 'risks-open',
    },
    {
        type: 'TENANT_LIST',
        defaultSize: { w: 12, h: 6 },
        defaultChartType: 'coverage',
    },
    {
        type: 'DRILLDOWN_CTAS',
        defaultSize: { w: 12, h: 2 },
        defaultChartType: 'default',
    },
];

const CHART_TYPE_OPTIONS: Record<WidgetTypeKey, ReadonlyArray<string>> = {
    KPI: ['coverage', 'critical-risks', 'overdue-evidence', 'tenants'],
    DONUT: ['rag-distribution'],
    TREND: ['risks-open', 'practices-coverage', 'evidence-overdue'],
    TENANT_LIST: ['coverage'],
    DRILLDOWN_CTAS: ['default'],
};

function defaultConfigFor(
    type: WidgetTypeKey,
    chartType: string,
): Record<string, unknown> {
    switch (type) {
        case 'KPI':
            return { format: chartType === 'coverage' ? 'percent' : 'number' };
        case 'DONUT':
            return { showLegend: true };
        case 'TREND':
            return { days: 90 };
        case 'TENANT_LIST':
            return { sortBy: 'rag' };
        case 'DRILLDOWN_CTAS':
            return {};
    }
}

// ─── Component ──────────────────────────────────────────────────────

export interface WidgetPickerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /**
     * Caller's persistence callback. Resolves with the persisted
     * widget so the parent can append it to its grid state.
     */
    onSubmit: (
        input: CreateOrgDashboardWidgetInput,
    ) => Promise<OrgDashboardWidgetDto>;
    /**
     * Fired after `onSubmit` resolves successfully. The picker closes
     * itself; the parent can refresh local state from this hook.
     */
    onCreated?: (widget: OrgDashboardWidgetDto) => void;
    /**
     * Default top-left position for the new widget. The vertical
     * compactor will adjust based on existing rows; the picker just
     * provides a sane starting point. Default `(0, 0)`.
     */
    defaultPosition?: WidgetPosition;
}

export function WidgetPicker({
    open,
    onOpenChange,
    onSubmit,
    onCreated,
    defaultPosition = { x: 0, y: 0 },
}: WidgetPickerProps) {
    const t = useTranslations('ui');
    const [type, setType] = useState<WidgetTypeKey>('KPI');
    const [chartType, setChartType] = useState<string>('coverage');
    const [title, setTitle] = useState<string>('');
    const [days, setDays] = useState<number>(90);
    const [showLegend, setShowLegend] = useState<boolean>(true);
    const [kpiFormat, setKpiFormat] = useState<'number' | 'percent'>(
        'percent',
    );
    const [tenantSort, setTenantSort] = useState<'rag' | 'name' | 'coverage'>(
        'rag',
    );
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const meta = useMemo(
        () => WIDGET_TYPES.find((w) => w.type === type) ?? WIDGET_TYPES[0],
        [type],
    );
    const variants = CHART_TYPE_OPTIONS[type];

    const typeLabels: Record<WidgetTypeKey, string> = {
        KPI: t('widgetPicker.kpiTileLabel'),
        DONUT: t('widgetPicker.donutBreakdownLabel'),
        TREND: t('widgetPicker.trendChartLabel'),
        TENANT_LIST: t('widgetPicker.tenantCoverageLabel'),
        DRILLDOWN_CTAS: t('widgetPicker.drilldownCtasLabel'),
    };
    const typeDescriptions: Record<WidgetTypeKey, string> = {
        KPI: t('widgetPicker.kpiTileDescription'),
        DONUT: t('widgetPicker.donutBreakdownDescription'),
        TREND: t('widgetPicker.trendChartDescription'),
        TENANT_LIST: t('widgetPicker.tenantCoverageDescription'),
        DRILLDOWN_CTAS: t('widgetPicker.drilldownCtasDescription'),
    };
    const chartLabels: Record<string, string> = {
        coverage: t('widgetPicker.chartCoverage'),
        'critical-risks': t('widgetPicker.chartCriticalRisks'),
        'overdue-evidence': t('widgetPicker.chartOverdueEvidence'),
        tenants: t('widgetPicker.chartTenants'),
        'rag-distribution': t('widgetPicker.chartRagDistribution'),
        'risks-open': t('widgetPicker.chartOpenRisks'),
        'practices-coverage': t('widgetPicker.chartPracticesCoverage'),
        'evidence-overdue': t('widgetPicker.chartOverdueEvidence'),
        default: t('widgetPicker.chartDefault'),
    };
    const chartTypeOptions: ComboboxOption[] = variants.map((v) => ({
        value: v,
        label: chartLabels[v],
    }));

    // Reset form when modal toggles closed → open transitions are
    // discoverable. We don't want a half-filled prior session
    // resurfacing on the next open.
    function resetState() {
        setType('KPI');
        setChartType('coverage');
        setTitle('');
        setDays(90);
        setShowLegend(true);
        setKpiFormat('percent');
        setTenantSort('rag');
        setError(null);
        setSubmitting(false);
    }

    function handleTypeChange(next: string) {
        const nextType = next as WidgetTypeKey;
        setType(nextType);
        const m = WIDGET_TYPES.find((w) => w.type === nextType);
        if (m) setChartType(m.defaultChartType);
        setError(null);
    }

    function buildConfig(): Record<string, unknown> {
        const base = defaultConfigFor(type, chartType);
        switch (type) {
            case 'KPI':
                return { ...base, format: kpiFormat };
            case 'TREND':
                return { ...base, days };
            case 'DONUT':
                return { ...base, showLegend };
            case 'TENANT_LIST':
                return { ...base, sortBy: tenantSort };
            case 'DRILLDOWN_CTAS':
                return base;
        }
    }

    async function handleSubmit() {
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            const input = {
                type,
                chartType,
                config: buildConfig(),
                title: title.trim().length > 0 ? title.trim() : null,
                position: defaultPosition,
                size: meta.defaultSize,
                enabled: true,
            } as CreateOrgDashboardWidgetInput;
            const widget = await onSubmit(input);
            onCreated?.(widget);
            onOpenChange(false);
            resetState();
        } catch (e) {
            setError(
                e instanceof Error
                    ? e.message
                    : t('widgetPicker.createError'),
            );
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Modal
            showModal={open}
            setShowModal={(next) => {
                // Modal's setShowModal accepts SetStateAction<boolean>;
                // resolve the optional updater form into a concrete
                // boolean before forwarding to the controlled callback.
                const resolved = typeof next === 'function' ? next(open) : next;
                onOpenChange(resolved);
                if (!resolved) resetState();
            }}
        >
            <Modal.Header
                title={t('widgetPicker.addWidget')}
                description={t('widgetPicker.modalDescription')}
            />
            <Modal.Body>
                <div className="space-y-section">
                    {/* ── Step 1: type ── */}
                    <FormField
                        label={t('widgetPicker.widgetTypeLabel')}
                        description={t('widgetPicker.widgetTypeDescription')}
                    >
                        <RadioGroup
                            value={type}
                            onValueChange={handleTypeChange}
                            data-testid="widget-picker-type"
                        >
                            {WIDGET_TYPES.map((opt) => (
                                <div
                                    key={opt.type}
                                    className="flex items-start gap-compact rounded-md border border-border-subtle p-3 hover:border-border-default"
                                >
                                    <RadioGroupItem
                                        value={opt.type}
                                        id={`widget-type-${opt.type}`}
                                        aria-label={typeLabels[opt.type]}
                                    />
                                    <div className="min-w-0">
                                        <Label
                                            htmlFor={`widget-type-${opt.type}`}
                                            className="text-sm font-medium text-content-emphasis cursor-pointer"
                                        >
                                            {typeLabels[opt.type]}
                                        </Label>
                                        <p className="text-xs text-content-muted mt-0.5">
                                            {typeDescriptions[opt.type]}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </RadioGroup>
                    </FormField>

                    {/* ── Step 2: chart variant ── */}
                    <FormField
                        label={t('widgetPicker.dataSourceLabel')}
                        description={
                            type === 'TREND'
                                ? t('widgetPicker.dataSourceTrendDescription')
                                : t('widgetPicker.dataSourceDefaultDescription')
                        }
                    >
                        <Combobox
                            forceDropdown
                            hideSearch
                            matchTriggerWidth
                            id="widget-picker-chart-type"
                            options={chartTypeOptions}
                            selected={
                                chartTypeOptions.find(
                                    (o) => o.value === chartType,
                                ) ?? null
                            }
                            setSelected={(opt) => opt && setChartType(opt.value)}
                        />
                    </FormField>

                    {/* ── Step 3: per-type config ── */}
                    {type === 'KPI' && (
                        <FormField
                            label={t('widgetPicker.formatLabel')}
                            description={t('widgetPicker.formatDescription')}
                        >
                            <RadioGroup
                                value={kpiFormat}
                                onValueChange={(v) =>
                                    setKpiFormat(v as 'number' | 'percent')
                                }
                                data-testid="widget-picker-kpi-format"
                                className="flex gap-default"
                            >
                                {[
                                    { value: 'number', label: t('widgetPicker.formatNumber') },
                                    { value: 'percent', label: t('widgetPicker.formatPercent') },
                                ].map((opt) => (
                                    <div
                                        key={opt.value}
                                        className="flex items-center gap-tight"
                                    >
                                        <RadioGroupItem
                                            value={opt.value}
                                            id={`kpi-format-${opt.value}`}
                                            aria-label={opt.label}
                                        />
                                        <Label
                                            htmlFor={`kpi-format-${opt.value}`}
                                            className="text-sm cursor-pointer"
                                        >
                                            {opt.label}
                                        </Label>
                                    </div>
                                ))}
                            </RadioGroup>
                        </FormField>
                    )}

                    {type === 'TREND' && (
                        <FormField
                            label={t('widgetPicker.windowDaysLabel')}
                            description={t('widgetPicker.windowDaysDescription')}
                        >
                            <input
                                type="number"
                                min={7}
                                max={365}
                                step={1}
                                value={days}
                                onChange={(e) => {
                                    const next = Number.parseInt(
                                        e.target.value,
                                        10,
                                    );
                                    if (Number.isFinite(next)) setDays(next);
                                }}
                                data-testid="widget-picker-trend-days"
                                className="block w-full rounded-md border border-border-default bg-bg-default px-3 py-2 text-sm text-content-emphasis focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                        </FormField>
                    )}

                    {type === 'DONUT' && (
                        <FormField label={t('widgetPicker.optionsLabel')}>
                            <label className="flex items-center gap-tight text-sm text-content-emphasis">
                                <input
                                    type="checkbox"
                                    checked={showLegend}
                                    onChange={(e) =>
                                        setShowLegend(e.target.checked)
                                    }
                                    data-testid="widget-picker-donut-legend"
                                    className="size-4 rounded border-border-default focus:ring-ring"
                                />
                                {t('widgetPicker.showLegend')}
                            </label>
                        </FormField>
                    )}

                    {type === 'TENANT_LIST' && (
                        <FormField
                            label={t('widgetPicker.sortByLabel')}
                            description={t('widgetPicker.sortByDescription')}
                        >
                            <RadioGroup
                                value={tenantSort}
                                onValueChange={(v) =>
                                    setTenantSort(
                                        v as 'rag' | 'name' | 'coverage',
                                    )
                                }
                                data-testid="widget-picker-tenant-sort"
                                className="flex flex-col gap-tight"
                            >
                                {[
                                    { value: 'rag', label: t('widgetPicker.sortRag') },
                                    { value: 'name', label: t('widgetPicker.sortName') },
                                    { value: 'coverage', label: t('widgetPicker.sortCoverage') },
                                ].map((opt) => (
                                    <div
                                        key={opt.value}
                                        className="flex items-center gap-tight"
                                    >
                                        <RadioGroupItem
                                            value={opt.value}
                                            id={`tenant-sort-${opt.value}`}
                                            aria-label={opt.label}
                                        />
                                        <Label
                                            htmlFor={`tenant-sort-${opt.value}`}
                                            className="text-sm cursor-pointer"
                                        >
                                            {opt.label}
                                        </Label>
                                    </div>
                                ))}
                            </RadioGroup>
                        </FormField>
                    )}

                    {/* ── Step 4: title (optional) ── */}
                    <FormField
                        label={t('widgetPicker.titleLabel')}
                        description={t('widgetPicker.titleDescription')}
                    >
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            maxLength={120}
                            placeholder={typeLabels[meta.type]}
                            data-testid="widget-picker-title"
                            className="block w-full rounded-md border border-border-default bg-bg-default px-3 py-2 text-sm text-content-emphasis placeholder:text-content-subtle focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                    </FormField>

                    {error && (
                        <div
                            role="alert"
                            data-testid="widget-picker-error"
                            className="rounded-md border border-border-error bg-bg-error/10 px-3 py-2 text-sm text-content-error"
                        >
                            {error}
                        </div>
                    )}
                </div>
            </Modal.Body>
            <Modal.Actions>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onOpenChange(false)}
                    data-testid="widget-picker-cancel"
                    disabled={submitting}
                >
                    {t('widgetPicker.cancel')}
                </Button>
                <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                        void handleSubmit();
                    }}
                    data-testid="widget-picker-submit"
                    disabled={submitting}
                >
                    {submitting ? t('widgetPicker.adding') : t('widgetPicker.addWidget')}
                </Button>
            </Modal.Actions>
        </Modal>
    );
}
