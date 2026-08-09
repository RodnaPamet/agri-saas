"use client";

/**
 * <EmptyState> — shared empty / no-results / preconditions-missing state.
 *
 * One primitive across the app for "this list is empty", "your filters
 * matched nothing", and "you need to do X before this view becomes
 * useful". Replaces the scattered ad-hoc empty messages that used to
 * sit inside cards as orphan paragraphs of muted text.
 *
 * Variants:
 *
 *   - `no-records` (default) — entity has no rows yet. Default icon:
 *     Inbox. Pair with a primary action to "create your first X".
 *   - `no-results` — the user's search/filter matched nothing. Default
 *     icon: SearchX. Pair with a "Clear filters" secondary action.
 *   - `missing-prereqs` — view requires setup the user hasn't done
 *     (e.g., "Connect a framework before installing practices").
 *     Default icon: AlertCircle. Pair with a primary action that
 *     navigates to the prerequisite flow.
 *
 * Action shape:
 *
 *   - `primary` — solid brand button (top action). Use for the most
 *     common next step.
 *   - `secondary` — ghost/outline button (sits to the right of primary).
 *     Use for "Clear filters", "Learn more", etc.
 *
 * The bare `icon` / `title` / `description` / `learnMore` / `children`
 * API stays backward-compatible — existing callers don't need to change.
 */

import { cn } from "@/lib/cn";
import { useTranslations } from "next-intl";
import { AlertCircle, Inbox, SearchX } from "lucide-react";
import { type PropsWithChildren, type ReactNode } from "react";
import { Button } from "./button";
import { buttonVariants } from "./button-variants";
import { TextLink } from "./typography";

// ─── Types ────────────────────────────────────────────────────────────

export type EmptyStateVariant = "no-records" | "no-results" | "missing-prereqs";

export interface EmptyStateAction {
    label: string;
    onClick?: () => void;
    /** When set, renders as `<a href>` instead of a button. */
    href?: string;
    /** Forwarded to the underlying practice (E2E selector). */
    "data-testid"?: string;
    /** Disable the button (loading or pre-condition unmet). */
    disabled?: boolean;
}

export type EmptyStateSize = "sm" | "md";

export interface EmptyStateProps extends PropsWithChildren {
    /**
     * Override the default icon for the variant. Pass any lucide-react
     * icon component (or any React.ElementType with a `className` prop).
     */
    icon?: React.ElementType;
    title: string;
    description?: ReactNode;
    /** Optional "Learn more ↗" external link appended to description. */
    learnMore?: string;
    /**
     * Variant drives the default icon and influences default copy
     * conventions. Defaults to `"no-records"`.
     */
    variant?: EmptyStateVariant;
    /**
     * Size axis (v2-PR-15). Defaults to `"md"`.
     *   "sm" — for in-card empties (DataTable empty state, sub-tab
     *          empties). 40px icon container, 8px vertical padding.
     *   "md" — for full-pane empties (list-page-with-no-rows).
     *          56px icon container, 48px vertical padding.
     */
    size?: EmptyStateSize;
    /** Primary action button (filled). */
    primaryAction?: EmptyStateAction;
    /** Secondary action button (ghost). Renders to the right of primary. */
    secondaryAction?: EmptyStateAction;
    className?: string;
    /** Forwarded to the outer wrapper for E2E selectors. */
    "data-testid"?: string;
}

// ─── Variant defaults ─────────────────────────────────────────────────

const variantIcon: Record<EmptyStateVariant, React.ElementType> = {
    "no-records": Inbox,
    "no-results": SearchX,
    "missing-prereqs": AlertCircle,
};

// ─── Component ────────────────────────────────────────────────────────

export function EmptyState({
    icon,
    title,
    description,
    learnMore,
    variant = "no-records",
    size = "md",
    primaryAction,
    secondaryAction,
    children,
    className,
    "data-testid": dataTestId,
}: EmptyStateProps) {
    const t = useTranslations("ui.emptyState");
    const Icon = icon ?? variantIcon[variant];

    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center",
                size === "sm"
                    ? "gap-y-2 py-2 px-3"
                    : "gap-y-4 py-12 px-6",
                className,
            )}
            data-testid={dataTestId ?? "empty-state"}
            data-empty-state-variant={variant}
            data-empty-state-size={size}
        >
            <div
                className={cn(
                    "flex items-center justify-center rounded-lg border border-border-subtle bg-bg-muted",
                    size === "sm" ? "size-10" : "size-14",
                )}
            >
                <Icon
                    className={cn(
                        "text-content-muted",
                        size === "sm" ? "size-4" : "size-6",
                    )}
                    aria-hidden="true"
                />
            </div>
            <p className="text-center text-base font-medium text-content-emphasis">
                {title}
            </p>
            {description && (
                <p className="max-w-sm text-balance text-center text-sm text-content-muted">
                    {description}{" "}
                    {learnMore && (
                        <TextLink
                            href={learnMore}
                            target="_blank"
                            rel="noopener noreferrer"
                            tone="underline"
                        >
                            {t("learnMore")}
                        </TextLink>
                    )}
                </p>
            )}
            {(primaryAction || secondaryAction) && (
                <div className="mt-2 flex flex-wrap items-center justify-center gap-tight">
                    {primaryAction && renderAction(primaryAction, "primary")}
                    {secondaryAction &&
                        renderAction(secondaryAction, "secondary")}
                </div>
            )}
            {children && <div className="mt-2">{children}</div>}
        </div>
    );
}

// ─── Action renderer ──────────────────────────────────────────────────

function renderAction(
    action: EmptyStateAction,
    intent: "primary" | "secondary",
) {
    const variant = intent === "primary" ? "primary" : "secondary";
    if (action.href) {
        return (
            <a
                href={action.href}
                className={cn(
                    buttonVariants({ variant, size: "sm" }),
                    action.disabled && "pointer-events-none opacity-50",
                )}
                data-testid={action["data-testid"]}
                aria-disabled={action.disabled || undefined}
            >
                {action.label}
            </a>
        );
    }
    return (
        <Button
            type="button"
            variant={variant}
            size="sm"
            onClick={action.onClick}
            disabled={action.disabled}
            data-testid={action["data-testid"]}
        >
            {action.label}
        </Button>
    );
}
