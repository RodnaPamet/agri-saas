"use client";

/**
 * `<ActionCluster>` — typed action-cluster primitive (v2-PR-14).
 *
 * Codifies the detail-page header action hierarchy:
 *
 *   ≤ 1 primary action
 *   ≤ 1 secondary action
 *   N overflow items (destructive + utilities) in a "More" menu
 *
 * Why this is a feature
 *   Detail pages today mix primary actions ("Edit"), bulk actions
 *   ("Archive", "Delete"), and contextual actions ("Run sync") in
 *   the header. No hierarchy. The header is the most-seen UI; a
 *   crowded action cluster screams "everything is equally important."
 *
 * Premium products tell the user the recommended next step:
 *   - Linear issue header: 1 primary "Open" + 1 secondary "Edit"
 *     + ⋯ menu (Archive, Delete, Move, Duplicate, …).
 *   - Stripe transaction detail: 1 primary "Refund" + ⋯ menu.
 *
 * Visual order (left → right):
 *   { secondary } { ⋯ overflow menu } { primary }
 *
 *   - Primary anchored to the right edge — most recommended action.
 *   - Secondary sits to the left of the menu — supporting action.
 *   - Overflow menu sits in the middle so right-hand-thumb taps on
 *     touch screens hit primary first; menu requires a deliberate
 *     tap.
 *
 * Pairs with:
 *   - `<EntityDetailLayout actions>` — the canonical home for this
 *     primitive.
 *   - `<PageHeader actions>` (v2-PR-5) — list-page primary action
 *     can also use this cluster.
 *   - `<Button>` variants from v2-PR-1 (primary | secondary |
 *     ghost | destructive | destructive-outline) — overflow items
 *     map to typed action shapes the menu renders correctly.
 */

import * as React from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/cn";
import { MoreHorizontal } from "lucide-react";

import { Button } from "./button";
import { Popover } from "./popover";

// ─── Types ────────────────────────────────────────────────────────

export interface ActionClusterAction {
    label: string;
    onClick?: () => void;
    /** When supplied, the cluster renders an `<a>` instead of a button. */
    href?: string;
    /** Disable the underlying practice. */
    disabled?: boolean;
    /** Forwarded to the underlying practice (E2E selector). */
    "data-testid"?: string;
}

export interface ActionClusterOverflowItem extends ActionClusterAction {
    /**
     * Tone the menu item renders with. `destructive` shows the
     * label in the error tone — for delete / archive actions.
     * Defaults to `default`.
     */
    tone?: "default" | "destructive";
    /** Optional inline icon rendered before the label. */
    icon?: React.ElementType;
}

export interface ActionClusterProps {
    /**
     * The single primary action — the recommended next step. Use
     * the destructive variant for cases where deleting the entity
     * IS the recommended next step (rare).
     */
    primary?: ActionClusterAction & {
        variant?: "primary" | "destructive";
    };
    /**
     * The single secondary action. Renders as a `<Button
     * variant="secondary">`.
     */
    secondary?: ActionClusterAction;
    /**
     * Overflow items rendered inside a "More" menu (the ⋯ button).
     * No upper limit — but if the list grows past ~6 items, the
     * page is hosting too many actions.
     */
    overflow?: ReadonlyArray<ActionClusterOverflowItem>;
    /** Layout overrides on the cluster wrapper. */
    className?: string;
    /** Forwarded to the cluster wrapper for E2E selectors. */
    "data-testid"?: string;
}

// ─── Component ────────────────────────────────────────────────────

function renderTriggerAction(
    action: ActionClusterAction,
    variant: "primary" | "secondary" | "destructive",
    testIdSuffix: string,
) {
    const inner = (
        <Button
            variant={variant}
            size="md"
            disabled={action.disabled}
            onClick={action.href ? undefined : action.onClick}
            data-testid={
                action["data-testid"] ?? `action-cluster-${testIdSuffix}`
            }
        >
            {action.label}
        </Button>
    );
    if (action.href) {
        return (
            <a href={action.href} className="inline-flex">
                {inner}
            </a>
        );
    }
    return inner;
}

export function ActionCluster({
    primary,
    secondary,
    overflow,
    className,
    "data-testid": dataTestId,
}: ActionClusterProps) {
    const t = useTranslations("ui");
    const [openMore, setOpenMore] = React.useState(false);
    const hasOverflow = overflow && overflow.length > 0;
    if (!primary && !secondary && !hasOverflow) return null;

    return (
        <div
            className={cn("flex items-center gap-tight flex-wrap", className)}
            data-action-cluster
            data-testid={dataTestId}
        >
            {secondary && renderTriggerAction(secondary, "secondary", "secondary")}
            {hasOverflow && (
                <Popover
                    openPopover={openMore}
                    setOpenPopover={setOpenMore}
                    content={
                        <Popover.Menu>
                            {overflow.map((item) => (
                                <Popover.Item
                                    key={item.label}
                                    onClick={
                                        item.href
                                            ? undefined
                                            : () => {
                                                  item.onClick?.();
                                                  setOpenMore(false);
                                              }
                                    }
                                    aria-label={item.label}
                                    disabled={item.disabled}
                                    data-testid={
                                        item["data-testid"] ??
                                        `action-cluster-overflow-${item.label}`
                                    }
                                    className={cn(
                                        item.tone === "destructive" &&
                                            "text-content-error",
                                    )}
                                >
                                    {item.icon && (
                                        <item.icon
                                            className="h-3.5 w-3.5 shrink-0"
                                            aria-hidden="true"
                                        />
                                    )}
                                    <span>{item.label}</span>
                                </Popover.Item>
                            ))}
                        </Popover.Menu>
                    }
                >
                    <Button
                        variant="ghost"
                        size="md"
                        aria-label={t("actionCluster.moreActions")}
                        data-testid="action-cluster-more"
                    >
                        <MoreHorizontal className="h-4 w-4" />
                    </Button>
                </Popover>
            )}
            {primary &&
                renderTriggerAction(primary, primary.variant ?? "primary", "primary")}
        </div>
    );
}
