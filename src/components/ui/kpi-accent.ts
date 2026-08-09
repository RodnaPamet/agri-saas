import type { MiniAreaChartVariant } from './mini-area-chart';

/**
 * KPI accent palette — the single controlled home for the per-card colour
 * scheme used on KPI filter cards (Asset list today; Practice / Risk / Task
 * / Vendor / Test / Policy lists next).
 *
 * Mirrors the dashboard `<KpiCard>` look: each accent is a distinct
 * `from-X to-Y` Tailwind gradient applied to the headline value text
 * (`bg-clip-text text-transparent`) plus a paired sparkline colour
 * variant, so a card's number and trendline read as one accent.
 *
 * Raw `from-/to-` gradient utilities are intentional here (the
 * `raw-color-eradication` guard only bans `text/bg/border-…` raw colours,
 * not gradient stops). Keeping every accent in THIS module means the
 * colours live in one reviewable place instead of being sprinkled across
 * every list page — that's what makes the pattern safe to fan out.
 */
export type KpiAccent =
    | 'emerald'
    | 'amber'
    | 'violet'
    | 'indigo'
    | 'sky'
    | 'rose'
    | 'slate';

export interface KpiAccentDef {
    /** `from-X to-Y` gradient for the headline value text. */
    gradient: string;
    /** Sparkline colour variant paired with this accent. */
    sparkline: MiniAreaChartVariant;
}

export const KPI_ACCENTS: Record<KpiAccent, KpiAccentDef> = {
    emerald: { gradient: 'from-emerald-500 to-teal-500', sparkline: 'success' },
    amber: { gradient: 'from-amber-500 to-orange-500', sparkline: 'warning' },
    violet: { gradient: 'from-purple-500 to-pink-500', sparkline: 'error' },
    indigo: { gradient: 'from-indigo-500 to-blue-500', sparkline: 'info' },
    sky: { gradient: 'from-sky-500 to-cyan-500', sparkline: 'brand' },
    rose: { gradient: 'from-rose-500 to-red-500', sparkline: 'error' },
    slate: { gradient: 'from-slate-400 to-slate-500', sparkline: 'neutral' },
};

/** The gradient classes for the headline value text of an accent. */
export function kpiAccentValueClass(accent: KpiAccent): string {
    return `bg-gradient-to-r ${KPI_ACCENTS[accent].gradient} bg-clip-text text-transparent`;
}
