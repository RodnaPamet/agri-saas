"use client";

/**
 * <ErrorState> — shared error surface (PR-8).
 *
 * Mirror of `<EmptyState>` for failed loads. One primitive replaces the
 * scattered "Failed to load" muted-text fallbacks that sat orphan inside
 * data cards. Use this whenever a fetch / mutation produces an error
 * the user can act on (retry, go back, contact support).
 *
 * Default shape:
 *   - icon (AlertTriangle, content-error tinted)
 *   - title (default: "Something went wrong")
 *   - description (the user-facing failure reason — never raw error JSON)
 *   - retry button (primary)
 *   - optional secondary action (ghost) — e.g. "Go back to dashboard"
 *
 * Render contract:
 *   - centred layout, `text-center`
 *   - subtle vertical padding so the surface reads as "we noticed
 *     something failed", not as "the whole card is now an error block"
 *   - error tone delivered via `text-content-error` on the icon and
 *     title — NOT a full red background, which would be over-emphasised
 *     for in-card recoverable errors
 *
 * NOT a replacement for:
 *   - Toast notifications (transient mutation failures with rollback)
 *   - Modal-level errors (shown via the Modal's footer slot)
 *   - The Next.js `error.tsx` boundary (full-page crash recovery)
 *
 * Pairs with:
 *   - `<EmptyState>` (when there's no data to show)
 *   - `<DataTable error>` prop (which can render `<ErrorState>` inline)
 */

import { cn } from "@/lib/cn";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { type PropsWithChildren, type ReactNode } from "react";
import { Button } from "./button";

// ─── Types ────────────────────────────────────────────────────────────

export interface ErrorStateAction {
    label: string;
    onClick?: () => void;
    /** When set, renders as `<a href>` instead of a button. */
    href?: string;
    /** Forwarded to the underlying practice (E2E selector). */
    "data-testid"?: string;
    /** Disable the button (e.g. while a retry is in flight). */
    disabled?: boolean;
}

export interface ErrorStateProps extends PropsWithChildren {
    /**
     * Override the default AlertTriangle icon. Pass any lucide-react
     * icon component (or any React.ElementType with a `className` prop).
     */
    icon?: React.ElementType;
    /** Defaults to "Something went wrong". */
    title?: string;
    /**
     * User-facing failure reason. Never echo back raw error JSON or
     * stack traces — the caller summarises the problem in plain text.
     */
    description?: ReactNode;
    /**
     * When provided, renders a primary "Try again" button (label
     * customisable via `retryLabel`) wired to this handler.
     */
    onRetry?: () => void;
    /** Defaults to "Try again". Ignored when `onRetry` is undefined. */
    retryLabel?: string;
    /** Disable the retry button (e.g. while a retry is in flight). */
    retryDisabled?: boolean;
    /**
     * Secondary action — typically "Go back" or "Contact support".
     * Renders to the right of the retry button.
     */
    secondaryAction?: ErrorStateAction;
    className?: string;
    /** Forwarded to the outer wrapper for E2E selectors. */
    "data-testid"?: string;
}

// ─── Component ────────────────────────────────────────────────────────

export function ErrorState({
    icon: IconOverride,
    title = "Something went wrong",
    description,
    onRetry,
    retryLabel = "Try again",
    retryDisabled = false,
    secondaryAction,
    children,
    className,
    "data-testid": dataTestId,
}: ErrorStateProps) {
    const Icon: React.ElementType = IconOverride ?? (AlertTriangle as LucideIcon);
    return (
        <div
            role="alert"
            aria-live="polite"
            className={cn(
                "flex flex-col items-center justify-center gap-compact px-6 py-12 text-center",
                className,
            )}
            data-testid={dataTestId}
        >
            <span className="rounded-full bg-bg-error p-3" aria-hidden="true">
                <Icon className="size-5 text-content-error" />
            </span>
            <div className="space-y-1">
                <p className="text-base font-semibold text-content-emphasis">
                    {title}
                </p>
                {description && (
                    <p className="max-w-sm text-balance text-sm text-content-muted">
                        {description}
                    </p>
                )}
            </div>
            {(onRetry || secondaryAction || children) && (
                <div className="mt-2 flex flex-wrap items-center justify-center gap-tight">
                    {onRetry && (
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={onRetry}
                            disabled={retryDisabled}
                            data-testid={
                                dataTestId ? `${dataTestId}-retry` : undefined
                            }
                        >
                            {retryLabel}
                        </Button>
                    )}
                    {secondaryAction && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={secondaryAction.onClick}
                            disabled={secondaryAction.disabled}
                            data-testid={secondaryAction["data-testid"]}
                        >
                            {secondaryAction.label}
                        </Button>
                    )}
                    {children}
                </div>
            )}
        </div>
    );
}
