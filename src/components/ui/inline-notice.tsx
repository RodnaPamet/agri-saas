"use client";

/**
 * <InlineNotice> — shared inline status banner (PR-10).
 *
 * Replaces the recurring 5-line hand-rolled block:
 *
 *   <div className="p-3 bg-bg-error border border-border-error rounded-lg flex items-center gap-tight">
 *     <XCircle className="w-4 h-4 text-content-error flex-shrink-0" />
 *     <span className="text-sm text-content-error">{error}</span>
 *     <button onClick={() => setError(null)}>...</button>
 *   </div>
 *
 * One primitive, four variants (error / success / warning / info), one
 * decision: do we want a dismiss control? The colour-pair tokens are
 * resolved internally so callers never spell `bg-bg-X border border-border-X`
 * inline again.
 *
 * Usage:
 *
 *   <InlineNotice variant="error" onDismiss={() => setError(null)}>
 *     Failed to revoke API key
 *   </InlineNotice>
 *
 *   <InlineNotice variant="success" title="Saved">
 *     Settings updated.
 *   </InlineNotice>
 *
 *   <InlineNotice variant="warning" icon={AlertTriangle}>
 *     This action cannot be undone.
 *   </InlineNotice>
 *
 * NOT a replacement for:
 *   - Toast notifications (transient — use sonner `toast.*`)
 *   - <ErrorState> (full-pane fetch failure with retry)
 *   - <Modal> footer-level error (modal owns that surface)
 *
 * Render contract:
 *   - role="status" for success/info/warning, role="alert" for error
 *   - aria-live="polite" so screen readers announce
 *   - dismiss button when onDismiss is supplied (X icon, aria-label)
 *
 * Pairs with:
 *   - <EmptyState> (when there's no data to show)
 *   - <ErrorState> (full-pane error surface)
 */

import { cn } from "@/lib/cn";
import {
    AlertTriangle,
    CheckCircle,
    Info,
    X,
    XCircle,
    type LucideIcon,
} from "lucide-react";
import { type PropsWithChildren, type ReactNode } from "react";

// ─── Types ────────────────────────────────────────────────────────────

export type InlineNoticeVariant = "error" | "success" | "warning" | "info";

export interface InlineNoticeProps extends PropsWithChildren {
    variant: InlineNoticeVariant;
    /**
     * Optional bold title rendered before the body. When set, the body
     * (children) wraps to the next line.
     */
    title?: ReactNode;
    /**
     * Override the default per-variant icon. Pass any lucide-react icon
     * component (or any React.ElementType with a `className` prop).
     * Pass `null` to render the notice without an icon.
     */
    icon?: React.ElementType | null;
    /**
     * When supplied, renders a dismiss (X) button on the trailing edge.
     * The handler is responsible for hiding the notice (e.g.
     * `setError(null)`).
     */
    onDismiss?: () => void;
    /** Forwarded to the dismiss button (default "Dismiss"). */
    dismissLabel?: string;
    className?: string;
    /** Forwarded to the outer wrapper for E2E selectors. */
    "data-testid"?: string;
    /** Forwarded to the outer wrapper. */
    id?: string;
}

// ─── Variant lookup ──────────────────────────────────────────────────

interface VariantTokens {
    bg: string;
    border: string;
    text: string;
    icon: LucideIcon;
    role: "alert" | "status";
}

const VARIANTS: Record<InlineNoticeVariant, VariantTokens> = {
    error: {
        bg: "bg-bg-error",
        border: "border-border-error",
        text: "text-content-error",
        icon: XCircle,
        role: "alert",
    },
    success: {
        bg: "bg-bg-success",
        border: "border-border-success",
        text: "text-content-success",
        icon: CheckCircle,
        role: "status",
    },
    warning: {
        bg: "bg-bg-warning",
        border: "border-border-warning",
        text: "text-content-warning",
        icon: AlertTriangle,
        role: "status",
    },
    info: {
        bg: "bg-bg-info",
        border: "border-border-info",
        text: "text-content-info",
        icon: Info,
        role: "status",
    },
};

// ─── Component ────────────────────────────────────────────────────────

export function InlineNotice({
    variant,
    title,
    icon,
    onDismiss,
    dismissLabel = "Dismiss",
    children,
    className,
    "data-testid": dataTestId,
    id,
}: InlineNoticeProps) {
    const tokens = VARIANTS[variant];
    const IconComp: React.ElementType | null =
        icon === null ? null : ((icon ?? tokens.icon) as React.ElementType);

    return (
        <div
            role={tokens.role}
            aria-live="polite"
            id={id}
            data-testid={dataTestId}
            className={cn(
                "flex items-start gap-tight rounded-lg border p-3 text-sm",
                tokens.bg,
                tokens.border,
                tokens.text,
                className,
            )}
        >
            {IconComp && (
                <IconComp
                    aria-hidden="true"
                    className={cn("h-4 w-4 flex-shrink-0", tokens.text)}
                />
            )}
            <div className="flex-1 min-w-0">
                {title && (
                    <p className={cn("font-medium", tokens.text)}>{title}</p>
                )}
                {children && (
                    <div
                        className={cn(
                            tokens.text,
                            title ? "mt-0.5 text-sm/relaxed" : "",
                        )}
                    >
                        {children}
                    </div>
                )}
            </div>
            {onDismiss && (
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label={dismissLabel}
                    className={cn(
                        "ml-auto flex-shrink-0 rounded p-0.5 transition hover:opacity-70",
                        tokens.text,
                    )}
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            )}
        </div>
    );
}
