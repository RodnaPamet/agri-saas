import { cn } from "@/lib/cn";
import { type ReactNode } from "react";

/**
 * Epic 59 — compact, reusable ProgressCircle.
 *
 * Stroke-only arc around an optional centre label. Token-backed
 * track + fill, size + status variants, and a proper ARIA progress
 * role so the circle reads correctly on KPI cards, table rows, and
 * inline compliance indicators.
 *
 * Example:
 *
 *   <ProgressCircle progress={0.62} label="62%" size="md" />
 *
 *   <ProgressCircle
 *       progress={coverage}
 *       variant={coverage >= 0.8 ? 'success' : 'warning'}
 *       size="sm"
 *       aria-label="Practice coverage"
 *   />
 */

export type ProgressCircleVariant =
    | "brand"
    | "success"
    | "warning"
    | "error"
    | "info"
    | "neutral";

export type ProgressCircleSize = "sm" | "md" | "lg";

interface ProgressCircleProps {
    /** Fractional progress in `[0, 1]`. Clamped for display. */
    progress: number;
    /** Stroke width in viewBox units (0-100 coordinate system). */
    strokeWidth?: number;
    /** Status variant — drives the arc colour token. */
    variant?: ProgressCircleVariant;
    /** Overall render size. */
    size?: ProgressCircleSize;
    /** Optional centre label (number, string, element). Omit for a bare ring. */
    label?: ReactNode;
    /** Accessible label — falls back to "Progress". */
    "aria-label"?: string;
    /** Extra classes on the root svg. */
    className?: string;
}

// ─── Variant + size token tables ─────────────────────────────────────

const VARIANT_STROKE: Record<ProgressCircleVariant, string> = {
    brand: "text-brand-emphasis",
    success: "text-content-success",
    warning: "text-content-warning",
    error: "text-content-error",
    info: "text-content-info",
    neutral: "text-content-muted",
};

const SIZE_ROOT: Record<ProgressCircleSize, string> = {
    sm: "size-8",
    md: "size-12",
    lg: "size-20",
};

const SIZE_LABEL: Record<ProgressCircleSize, string> = {
    sm: "text-[10px]",
    md: "text-xs",
    lg: "text-sm",
};

// ─── Component ───────────────────────────────────────────────────────

export function ProgressCircle({
    progress: progressProp,
    strokeWidth = 12,
    variant = "brand",
    size = "md",
    label,
    "aria-label": ariaLabel = "Progress",
    className,
}: ProgressCircleProps) {
    const progress = Math.min(Math.max(progressProp, 0), 1);
    const radius = (100 - strokeWidth) / 2;
    const circumference = radius * Math.PI * 2;
    const dash = progress * circumference;
    const pct = Math.round(progress * 100);

    const svg = (
        <svg
            viewBox="0 0 100 100"
            role="progressbar"
            aria-label={ariaLabel}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className={cn("h-full w-full shrink-0", VARIANT_STROKE[variant])}>
            {/* Track */}
            <circle
                cx="50"
                cy="50"
                r={radius}
                strokeWidth={`${strokeWidth}px`}
                fill="none"
                strokeLinecap="round"
                stroke="var(--border-subtle)"
            />
            {/* Progress arc */}
            {progress > 0 && (
                <circle
                    cx="50"
                    cy="50"
                    r={radius}
                    stroke="currentColor"
                    strokeWidth={`${strokeWidth}px`}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={`${dash} ${circumference - dash}`}
                    style={{
                        transformOrigin: "50px 50px",
                        transform: "rotate(-90deg)",
                    }}
                />
            )}
        </svg>
    );

    if (label === undefined || label === null) {
        return <div className={cn(SIZE_ROOT[size], className)}>{svg}</div>;
    }

    return (
        <div
            className={cn(
                "relative flex items-center justify-center",
                SIZE_ROOT[size],
                className,
            )}>
            {svg}
            <span
                className={cn(
                    "absolute inset-0 flex items-center justify-center font-medium tabular-nums text-content-emphasis",
                    SIZE_LABEL[size],
                )}>
                {label}
            </span>
        </div>
    );
}
