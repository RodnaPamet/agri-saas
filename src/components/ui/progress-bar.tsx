"use client";

import { cn } from "@/lib/cn";
import { motion } from "motion/react";

/**
 * Epic 59 — compact, reusable ProgressBar.
 *
 * Token-backed track + fill, ARIA-complete, size + status variants so
 * callers can drop one into a KPI card, a table row, an inline form
 * indicator, or a dashboard coverage strip without rebuilding a
 * bespoke bar each time.
 *
 * Example:
 *
 *   <ProgressBar value={75} aria-label="Control coverage" showValue />
 *
 *   <ProgressBar
 *       value={failureRate}
 *       variant={failureRate > 5 ? 'error' : 'success'}
 *       size="sm"
 *   />
 */

export type ProgressBarVariant =
    | "brand"
    | "success"
    | "warning"
    | "error"
    | "info"
    | "neutral";

export type ProgressBarSize = "sm" | "md" | "lg";

interface ProgressBarProps {
    /** Current value. Clamped to `[0, max]` for display; `> max` sets `data-overflow`. */
    value?: number;
    /** Upper bound. Defaults to 100 (percent scale). */
    max?: number;
    /** Status variant — drives the fill colour token. */
    variant?: ProgressBarVariant;
    /** Bar height. */
    size?: ProgressBarSize;
    /** Render the `{percent}%` label to the right. */
    showValue?: boolean;
    /** Accessible label — falls back to "Progress" when omitted. */
    "aria-label"?: string;
    /** Extra classes on the outer wrapper. */
    className?: string;
}

// ─── Variant + size token tables ─────────────────────────────────────

const VARIANT_FILL: Record<ProgressBarVariant, string> = {
    brand: "bg-brand-emphasis",
    success: "bg-[var(--content-success)]",
    warning: "bg-[var(--content-warning)]",
    error: "bg-[var(--content-error)]",
    info: "bg-[var(--content-info)]",
    neutral: "bg-content-muted",
};

const SIZE_HEIGHT: Record<ProgressBarSize, string> = {
    sm: "h-1",
    md: "h-2",
    lg: "h-3",
};

// ─── Component ───────────────────────────────────────────────────────

export function ProgressBar({
    value = 0,
    max = 100,
    variant = "brand",
    size = "md",
    showValue = false,
    className,
    "aria-label": ariaLabel = "Progress",
}: ProgressBarProps) {
    const safeMax = max > 0 ? max : 0;
    const clampedValue = Math.max(0, value);
    const effectiveValue = Math.min(clampedValue, safeMax);
    // The BAR is clamped — it cannot render past its own track. The NUMBER is
    // not: an over-full bin is the one signal a farmer most needs, and showing
    // "100%" for a 140%-full bin while the aria-label said 140% meant sighted
    // and screen-reader users were told different things about the same bin.
    const percent = safeMax === 0 ? 0 : (effectiveValue / safeMax) * 100;
    const truePercent = safeMax === 0 ? 0 : (clampedValue / safeMax) * 100;
    const overflowed = value > safeMax && safeMax > 0;
    // `aria-valuetext` is the spec-sanctioned human-readable value and is what
    // assistive tech announces; `aria-valuenow` stays in [min,max] as ARIA
    // requires. Both now describe the same reality as the visible label.
    const valueText = `${truePercent.toFixed(0)}%`;

    const track = (
        <div
            role="progressbar"
            aria-label={ariaLabel}
            aria-valuenow={effectiveValue}
            aria-valuetext={valueText}
            aria-valuemin={0}
            aria-valuemax={safeMax}
            data-overflow={overflowed ? "true" : undefined}
            className={cn(
                "w-full overflow-hidden rounded-full bg-bg-subtle",
                SIZE_HEIGHT[size],
                // Overflow is visible, not just announced: a full track alone
                // is indistinguishable from exactly-100%.
                overflowed && "ring-1 ring-border-emphasis",
                !showValue && className,
            )}>
            <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${percent}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                className={cn("h-full", VARIANT_FILL[variant])}
            />
        </div>
    );

    if (!showValue) return track;

    return (
        <div className={cn("flex items-center gap-compact", className)}>
            <div className="flex-1">{track}</div>
            <span className="min-w-[2.75rem] text-right text-xs tabular-nums text-content-muted">
                {valueText}
            </span>
        </div>
    );
}
