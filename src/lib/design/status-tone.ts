/**
 * Polish PR-7 — Status-tone helper.
 *
 * One vocabulary for chart, heatmap, and sparkline tone across the
 * product. Until this PR every chart invented its own colour
 * function:
 *   - risks/dashboard heatmap mapped score → bg-bg-success / warning
 *     / orange-900 / bg-bg-error inline
 *   - CalendarHeatmap intensity → 0-4 brand-alpha steps
 *   - CalendarMonth dot colours → semantic + brand mix
 *   - GanttTimeline bar colours → mirror of CalendarMonth, hand-typed
 *   - coverage/CoverageClient pct → hex literals (#22c55e / #f59e0b /
 *     #ef4444) for SVG fill, separate Tailwind class set for text
 *
 * Result: dark↔light theme parity was brittle — each chart shipped
 * its own override. This module collapses the four colour functions
 * into one set of helpers that flow through the semantic status
 * tokens (`--bg-success` / `--bg-warning` / `--bg-error` /
 * `--brand-default` etc.) so a theme flip re-tones every chart
 * automatically.
 *
 * Public API
 *
 *   getStatusTone(value, scale)
 *     Maps a numeric value on a {ok | warn | error} scale to a tone
 *     bundle of Tailwind classes (background / content / border).
 *     The `scale` argument controls the threshold semantics —
 *     `score-0-25` for risk heatmaps, `pct-0-100` for coverage
 *     percentages, `count-0-N` for "any > 0 is attention" UX.
 *
 *   getCategoryTone(category)
 *     Maps a nominal calendar category (`evidence | policy | …`) to
 *     its dot/bar colour bundle. Mirrors the CalendarMonth +
 *     GanttTimeline maps so the two views feel like one system.
 *
 *   getIntensityTone(bucket)
 *     Maps a 0-4 intensity bucket to a brand-alpha background. Used
 *     by CalendarHeatmap and any future density-style chart.
 *
 * Why semantic tokens, not hex
 *   Hex literals don't re-theme. The semantic tokens already meet
 *   WCAG AA in both themes (the `--content-success` / warning /
 *   error tones were tuned in GAP-CI-77). Charts deserve the same
 *   contrast guarantees as text.
 */

import type { CalendarEventCategory } from '@/app-layer/schemas/calendar.schemas';

// ─── Tone bundle ─────────────────────────────────────────────────────

export interface ToneBundle {
    /** Background class (use for chart fills, heatmap cells, badges). */
    bg: string;
    /** Foreground / content class (use for text-on-tinted-surface). */
    content: string;
    /** Border class (use for ring + outline accents). */
    border: string;
}

const TONE_NEUTRAL: ToneBundle = {
    bg: 'bg-bg-muted/40',
    content: 'text-content-muted',
    border: 'border-border-subtle',
};

const TONE_SUCCESS: ToneBundle = {
    bg: 'bg-bg-success',
    content: 'text-content-success',
    border: 'border-border-success',
};

const TONE_ATTENTION: ToneBundle = {
    bg: 'bg-bg-warning',
    content: 'text-content-warning',
    border: 'border-border-warning',
};

const TONE_CRITICAL: ToneBundle = {
    bg: 'bg-bg-error',
    content: 'text-content-error',
    border: 'border-border-error',
};

// ─── Status scale ────────────────────────────────────────────────────

export type StatusScale =
    /** Coverage / completion 0-100 percentage. */
    | 'pct-0-100'
    /** Pass-rate 0-100 — same thresholds as pct, semantic alias. */
    | 'pass-rate-0-100'
    /** Count where any >0 is attention, threshold marks critical. */
    | { kind: 'count-attention'; criticalAt: number };

/**
 * Map a numeric value to a tone bundle. The thresholds depend on the
 * scale.
 *
 * Examples:
 *   getStatusTone(85, 'pct-0-100')       // → TONE_SUCCESS
 *   getStatusTone(3, { kind: 'count-attention', criticalAt: 5 })
 *                                        // → TONE_ATTENTION
 *
 * RQ3-9 — the `score-0-25` scale was REMOVED. Risk-score colouring
 * now flows through `resolveBandForScore` (the canonical matrix-
 * config band resolver) so the heatmap, the panel chip, and the
 * PDF exporter all read the same tenant-bands shape. A hard-coded
 * 0-25 ladder here was a second source of truth that could drift.
 *
 * Use `getStatusTone` for percentage / count-based UX (coverage,
 * pass-rate, "any > 0 is attention"). For RISK scores reach for
 * `resolveBandForScore` instead — it returns the canonical band
 * for the score per the tenant's matrix config.
 */
export function getStatusTone(value: number, scale: StatusScale): ToneBundle {
    if (scale === 'pct-0-100' || scale === 'pass-rate-0-100') {
        // Coverage / pass-rate — ≥80 ok, ≥50 warn, < 50 critical.
        if (value >= 80) return TONE_SUCCESS;
        if (value >= 50) return TONE_ATTENTION;
        return TONE_CRITICAL;
    }
    // count-attention: 0 = neutral, 1..criticalAt-1 = attention, ≥
    // criticalAt = critical.
    if (value <= 0) return TONE_NEUTRAL;
    if (value < scale.criticalAt) return TONE_ATTENTION;
    return TONE_CRITICAL;
}

// ─── Category map (calendar / gantt) ─────────────────────────────────

/**
 * Map a nominal calendar event category to its tone bundle. Used by
 * CalendarMonth (dots), GanttTimeline (bars), and any future surface
 * that renders calendar entities.
 */
export function getCategoryTone(category: CalendarEventCategory): ToneBundle {
    switch (category) {
        case 'evidence':
            return {
                bg: 'bg-status-info',
                content: 'text-content-info',
                border: 'border-border-info',
            };
        case 'policy':
            return {
                bg: 'bg-status-warning',
                content: 'text-content-warning',
                border: 'border-border-warning',
            };
        case 'vendor':
            return {
                bg: 'bg-[var(--brand-default)]',
                content: 'text-[var(--brand-default)]',
                border: 'border-[var(--brand-default)]',
            };
        case 'audit':
            return {
                bg: 'bg-content-emphasis',
                content: 'text-content-emphasis',
                border: 'border-border-emphasis',
            };
        case 'practice':
            return {
                bg: 'bg-status-success',
                content: 'text-content-success',
                border: 'border-border-success',
            };
        case 'task':
            return {
                bg: 'bg-content-muted',
                content: 'text-content-muted',
                border: 'border-border-default',
            };
        case 'risk':
            return {
                bg: 'bg-status-danger',
                content: 'text-content-error',
                border: 'border-border-error',
            };
        case 'finding':
            return {
                bg: 'bg-status-warning',
                content: 'text-content-warning',
                border: 'border-border-warning',
            };
        // Field work — split off from `task` so it reads as "your farm's
        // own to-do" rather than a compliance deadline.
        case 'farm-task':
            return {
                bg: 'bg-status-success',
                content: 'text-content-success',
                border: 'border-border-success',
            };
        // A land-lease term ending is a renewal decision, same urgency
        // register as a policy review.
        case 'lease':
            return {
                bg: 'bg-status-warning',
                content: 'text-content-warning',
                border: 'border-border-warning',
            };
        // A marketing contract's delivery window — brand tone, mirroring
        // `vendor`: both are a commercial counterparty relationship.
        case 'contract':
            return {
                bg: 'bg-[var(--brand-default)]',
                content: 'text-[var(--brand-default)]',
                border: 'border-[var(--brand-default)]',
            };
        // A planting cycle is agronomic information, not an obligation —
        // same tone family as `evidence`/`agri-event`.
        case 'planting':
            return {
                bg: 'bg-status-info',
                content: 'text-content-info',
                border: 'border-border-info',
            };
        // Agro-signals ARE alerts (spray-window unsuitable, disease risk
        // escalation) — the danger tone matches `risk`.
        case 'agro-signal':
            return {
                bg: 'bg-status-danger',
                content: 'text-content-error',
                border: 'border-border-error',
            };
        // Curated agriculture catalogue. Deliberately the info tone rather
        // than a status tone: these are announcements, not obligations the
        // tenant is being measured against, and toning them like a deadline
        // would overstate them.
        case 'agri-event':
            return {
                bg: 'bg-status-info',
                content: 'text-content-info',
                border: 'border-border-info',
            };
        // AI news-derived proposals (calendar roadmap PR 3). Same info
        // family as `agri-event` — both are announcements, not
        // obligations — but the DOT ITSELF is rendered hollow/dashed by
        // CalendarMonth (keyed off `CalendarEvent.provenance`, not this
        // tone) so an AI-sourced entry is never visually indistinguishable
        // from a curated fact even though they share a colour family.
        case 'ai-news':
            return {
                bg: 'bg-status-info',
                content: 'text-content-info',
                border: 'border-border-info',
            };
    }
}

// ─── Intensity scale (0-4) ───────────────────────────────────────────

export type IntensityBucket = 0 | 1 | 2 | 3 | 4;

const INTENSITY_BG: Record<IntensityBucket, string> = {
    0: 'bg-bg-muted/40',
    1: 'bg-[var(--brand-default)]/20',
    2: 'bg-[var(--brand-default)]/40',
    3: 'bg-[var(--brand-default)]/60',
    4: 'bg-[var(--brand-default)]/85',
};

/**
 * Brand-alpha intensity for sequential heatmap-style charts (0-4
 * buckets). Used by CalendarHeatmap; reuse for any future activity-
 * density visual.
 */
export function getIntensityTone(bucket: IntensityBucket): string {
    return INTENSITY_BG[bucket];
}

/**
 * Bucket a count + max-density into the 0-4 intensity scale. Mirrors
 * the existing CalendarHeatmap `bucketIntensity(count, max)` so the
 * heatmap consumes the helper without changing its bucketing logic.
 */
export function bucketIntensity(
    count: number,
    max: number,
): IntensityBucket {
    if (count === 0 || max === 0) return 0;
    const ratio = count / max;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
}
