"use client";

import { cn } from "@/lib/cn";
import { motion } from "motion/react";

/**
 * A signed magnitude, either side of a visible zero.
 *
 * ── Why this is not ProgressBar ─────────────────────────────────────
 *
 * `ProgressBar` floors its input with `Math.max(0, value)` before doing
 * anything else, so a loss and a break-even come out identical in the
 * fill, the label, `aria-valuenow` and `aria-valuetext`. That is correct
 * for progress — you cannot be less than 0% done — and wrong for any
 * signed quantity, where "lost money" and "made nothing" are the two
 * answers a reader most needs to tell apart. Overflow is preserved there
 * and surfaced three ways; underflow is destroyed silently.
 *
 * ── Why this is not in components/ui/charts/ ────────────────────────
 *
 * That platform is time-series only: its bar renderer requires a band
 * scale over Dates. It also has its module layout and barrel exports
 * pinned by a guardrail, so a new file there is a structural change to
 * the platform rather than an addition to it. This sits beside
 * `ProgressBar` because that is what it is — the signed sibling.
 *
 * ── role="meter" ────────────────────────────────────────────────────
 *
 * ARIA defines `progressbar` as the completion of a task, and its range
 * starts at zero. `meter` is "a scalar measurement within a known range",
 * which is exactly this, and it accepts a negative `aria-valuemin` so the
 * sign survives into assistive tech rather than being clamped away.
 *
 * Example:
 *
 *   <DivergingBar
 *       value={marginPerDca}
 *       max={largestAbsoluteMarginOnScreen}
 *       valueText="+80 EUR/dca"
 *       aria-label="Wheat: margin per decare"
 *   />
 */

export type DivergingBarSize = "sm" | "md" | "lg";

interface DivergingBarProps {
    /** Signed value. Negative renders left of the baseline, positive right. */
    value: number;
    /**
     * Largest magnitude on the shared scale — normally
     * `max(|value|)` across every bar rendered together.
     *
     * One max for the whole group is the point: a bar that sized itself to
     * its own value would make every row look the same length, which is
     * the specific way a per-row bar lies.
     */
    max: number;
    /**
     * Human-readable value, units included. The bar plots a bare
     * magnitude; only the caller knows it is money per decare, so without
     * this the announced value is a naked number.
     */
    valueText?: string;
    size?: DivergingBarSize;
    /** Accessible label. Name the subject — the value rides `valueText`. */
    "aria-label": string;
    className?: string;
}

const SIZE_HEIGHT: Record<DivergingBarSize, string> = {
    sm: "h-1",
    md: "h-2",
    lg: "h-3",
};

export function DivergingBar({
    value,
    max,
    valueText,
    size = "md",
    className,
    "aria-label": ariaLabel,
}: DivergingBarProps) {
    const finiteValue = Number.isFinite(value) ? value : 0;
    // `> 0` and not `!== 0`: this also rejects NaN and negatives, either of
    // which would otherwise reach the division and come back as a confident
    // position on a scale that does not exist.
    const hasScale = Number.isFinite(max) && max > 0;

    const negative = finiteValue < 0;
    const magnitude = Math.abs(finiteValue);
    const overflowed = hasScale && magnitude > max;
    // Each side owns half the track, so a value at the scale maximum fills
    // its half exactly. The FILL is clamped — it cannot render past its own
    // track — while the true figure stays in `aria-valuetext` and in
    // whatever the caller prints beside it. Same contract ProgressBar
    // settled on for overflow, for the same reason.
    const halfPercent = hasScale ? Math.min(magnitude / max, 1) * 50 : 0;

    return (
        <div
            role="meter"
            aria-label={ariaLabel}
            aria-valuenow={finiteValue}
            {...(hasScale ? { "aria-valuemin": -max, "aria-valuemax": max } : {})}
            {...(valueText ? { "aria-valuetext": valueText } : {})}
            data-sign={negative ? "negative" : "positive"}
            data-overflow={overflowed ? "true" : undefined}
            // An absent scale is stated rather than faked. Nothing is drawn,
            // because any drawn length would imply a measurement.
            data-scale={hasScale ? undefined : "none"}
            className={cn(
                "relative w-full overflow-hidden rounded-full bg-bg-subtle",
                SIZE_HEIGHT[size],
                overflowed && "ring-1 ring-border-emphasis",
                className,
            )}>
            {/* The baseline is not decoration. Bar lengths on a diverging
                scale are unreadable without the zero they diverge from, and
                a reader who cannot see the fill colour has only the SIDE to
                tell profit from loss. */}
            <div
                data-testid="diverging-bar-baseline"
                aria-hidden="true"
                className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-emphasis"
            />
            {hasScale && magnitude > 0 && (
                <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${halfPercent}%` }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                    className={cn(
                        "absolute inset-y-0",
                        negative
                            ? "right-1/2 rounded-l-full bg-[var(--content-error)]"
                            : "left-1/2 rounded-r-full bg-[var(--content-success)]",
                    )}
                />
            )}
        </div>
    );
}
