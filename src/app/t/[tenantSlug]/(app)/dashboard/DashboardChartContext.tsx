/**
 * R17-PR6 — Dashboard chart-filter coordination context.
 *
 * The dashboard's KPI tiles (practice coverage, risks, evidence,
 * tasks, policies, findings) and the charts below them are
 * currently siblings — each renders the same payload independently.
 * Roadmap-17's interactive layer makes them speak the same
 * coordinated state:
 *
 *   • Clicking a KPI tile sets that tile as the "current focus."
 *   • Charts subscribe to the focus via `useDashboardChartFilter()`.
 *   • When focus changes, the donut, the coverage breakdown, and
 *     the evidence status section all re-render with data filtered
 *     to the selected resource (PR-7..9 wire the consumers; this
 *     PR ships the foundation).
 *
 * Why a context rather than prop-drilling:
 *   • Six KPI tiles × four chart sections × the masthead is a
 *     ~30-edge graph if propped — visual fan-out would dwarf the
 *     actual logic.
 *   • Future filter sources (the eventual chart-on-chart drill-
 *     down, the segment-row click on the donut) want the same
 *     setter. A single context is the canonical join point.
 *
 * The KPI keys are typed as a finite union — adding a new tile
 * type requires touching this file, which in turn forces the
 * filter-aware chart consumers (PR-8+) to handle the new case.
 *
 * Default state: `null` — the dashboard renders the unfiltered
 * baseline, identical byte-for-byte to today's render.
 */
'use client';

import * as React from 'react';

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Canonical KPI key set. Each value corresponds 1:1 to one of the
 * `<KpiCard>` tiles in the dashboard grid. Adding a tile means
 * adding a key here; the type-narrowing in PR-8's chart consumers
 * forces the new key to be handled at every subscription site.
 */
export type DashboardKpiKey = 'risks' | 'evidence';

/** Public shape of the context for consumers. */
export interface DashboardChartFilter {
    /** Currently focused KPI, or `null` when no tile is selected. */
    selectedKpi: DashboardKpiKey | null;
    /**
     * Set the focus. Pass `null` to clear. The setter is stable
     * across renders so consumers can list it in effect deps
     * without triggering re-runs.
     */
    setSelectedKpi: (kpi: DashboardKpiKey | null) => void;
    /**
     * Toggle the focus on/off for a given key. Clicking the
     * currently-selected tile clears the filter; clicking any
     * other tile sets it.
     */
    toggleSelectedKpi: (kpi: DashboardKpiKey) => void;
}

// ─── Context ─────────────────────────────────────────────────────────

/**
 * Internal context handle. We don't export the bare Context so
 * consumers go through `useDashboardChartFilter()` and get a
 * clear error if they're outside the provider.
 */
const DashboardChartFilterContext =
    React.createContext<DashboardChartFilter | null>(null);

// ─── Provider ────────────────────────────────────────────────────────

interface DashboardChartProviderProps {
    children: React.ReactNode;
}

export function DashboardChartProvider({
    children,
}: DashboardChartProviderProps) {
    const [selectedKpi, setSelectedKpi] =
        React.useState<DashboardKpiKey | null>(null);

    const toggleSelectedKpi = React.useCallback(
        (kpi: DashboardKpiKey) => {
            setSelectedKpi((current) => (current === kpi ? null : kpi));
        },
        [],
    );

    const value = React.useMemo<DashboardChartFilter>(
        () => ({
            selectedKpi,
            setSelectedKpi,
            toggleSelectedKpi,
        }),
        [selectedKpi, toggleSelectedKpi],
    );

    return (
        <DashboardChartFilterContext.Provider value={value}>
            {children}
        </DashboardChartFilterContext.Provider>
    );
}

// ─── Hook ────────────────────────────────────────────────────────────

/**
 * Subscribe to the dashboard chart-filter state. Throws if called
 * outside a `<DashboardChartProvider>` — keeps the misuse fail-
 * fast at the call site instead of producing silent "no filter
 * ever fires" behaviour.
 */
export function useDashboardChartFilter(): DashboardChartFilter {
    const ctx = React.useContext(DashboardChartFilterContext);
    if (!ctx) {
        throw new Error(
            'useDashboardChartFilter must be used inside <DashboardChartProvider>',
        );
    }
    return ctx;
}
