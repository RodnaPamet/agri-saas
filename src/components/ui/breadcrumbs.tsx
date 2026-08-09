"use client";

/**
 * <Breadcrumbs> — semantic, reusable breadcrumb trail.
 *
 * Renders a `<nav aria-label="Breadcrumb">` containing an `<ol>` of
 * items. Items with an `href` are clickable links; items without are
 * plain spans. The final item (or any item with `current: true`) gets
 * `aria-current="page"`.
 *
 * Use across:
 *   - List pages — usually one ancestor: `[Dashboard] / Practices`
 *   - Detail pages — `[Dashboard] / Practices / <Practice name>`
 *   - Admin — `[Dashboard] / Admin / API keys`
 *   - Wizards — `[Dashboard] / Risks / Import / Step 2`
 *
 * Pair with `<EntityListPage header.breadcrumbs>` or
 * `<EntityDetailLayout breadcrumbs>` to render above the page title.
 *
 * Truncation: when the path is long, middle items collapse to a `…`
 * disclosure that expands on focus. The first and last items always
 * render in full so the user sees both root and current.
 */

import Link from "next/link";
import * as React from "react";

import { cn } from "@/lib/cn";

// ─── Item shape ──────────────────────────────────────────────────────

export interface BreadcrumbItem {
    /** Visible label. ReactNode allowed for icons + truncated names. */
    label: React.ReactNode;
    /**
     * Link target. Omit (or pass null) to render as a plain span — use
     * for the current page.
     */
    href?: string | null;
    /**
     * When true, marks this item as the current page (`aria-current="page"`).
     * If omitted, the last item is automatically treated as current.
     */
    current?: boolean;
    /** Forwarded to the underlying anchor / span (for E2E selectors). */
    "data-testid"?: string;
}

// ─── Component props ─────────────────────────────────────────────────

export interface BreadcrumbsProps {
    items: ReadonlyArray<BreadcrumbItem>;
    /** Custom separator between items. Default: "/". */
    separator?: React.ReactNode;
    /**
     * When the path has more than this many items, middle items collapse
     * behind a "…" disclosure. First + last are always shown. Set to
     * `Infinity` to disable. Default: 4.
     */
    maxVisible?: number;
    className?: string;
    "aria-label"?: string;
    "data-testid"?: string;
}

// ─── Component ───────────────────────────────────────────────────────

export function Breadcrumbs({
    items,
    separator = "/",
    maxVisible = 4,
    className,
    "aria-label": ariaLabel = "Breadcrumb",
    "data-testid": dataTestId = "breadcrumbs",
}: BreadcrumbsProps) {
    if (!items.length) return null;

    const lastIndex = items.length - 1;
    const visible = collapse(items, maxVisible);

    return (
        <nav
            aria-label={ariaLabel}
            className={cn("flex items-center text-xs", className)}
            data-testid={dataTestId}
        >
            <ol className="flex items-center gap-1 flex-wrap min-w-0">
                {visible.map((entry, idx) => {
                    if (entry === "ellipsis") {
                        return (
                            <li
                                key={`ellipsis-${idx}`}
                                className="flex items-center gap-1 text-content-muted"
                                aria-hidden="true"
                            >
                                <span>…</span>
                                <SeparatorView>{separator}</SeparatorView>
                            </li>
                        );
                    }

                    const item = entry.item;
                    const isLast = entry.index === lastIndex;
                    const isCurrent = item.current ?? isLast;
                    const showSeparator = !isLast;

                    return (
                        <li
                            key={`crumb-${entry.index}`}
                            className="flex items-center gap-1 min-w-0"
                        >
                            {item.href && !isCurrent ? (
                                <Link
                                    href={item.href}
                                    className="text-content-muted hover:text-content-emphasis transition truncate max-w-trunc-loose"
                                    data-testid={item["data-testid"]}
                                >
                                    {item.label}
                                </Link>
                            ) : (
                                <span
                                    className={cn(
                                        "truncate max-w-trunc-loose",
                                        isCurrent
                                            ? "text-content-emphasis font-medium"
                                            : "text-content-muted",
                                    )}
                                    aria-current={isCurrent ? "page" : undefined}
                                    data-testid={item["data-testid"]}
                                >
                                    {item.label}
                                </span>
                            )}
                            {showSeparator && (
                                <SeparatorView>{separator}</SeparatorView>
                            )}
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface CrumbEntry {
    index: number;
    item: BreadcrumbItem;
}
type CollapsedEntry = CrumbEntry | "ellipsis";

/**
 * Collapse middle items when the path is longer than `maxVisible`.
 * Always preserves the first and the last item; the middle becomes a
 * single `"ellipsis"` marker.
 */
function collapse(
    items: ReadonlyArray<BreadcrumbItem>,
    maxVisible: number,
): CollapsedEntry[] {
    if (items.length <= maxVisible) {
        return items.map((item, index) => ({ index, item }));
    }
    return [
        { index: 0, item: items[0] },
        "ellipsis",
        { index: items.length - 1, item: items[items.length - 1] },
    ];
}

function SeparatorView({ children }: { children: React.ReactNode }) {
    return (
        <span
            className="text-content-subtle select-none"
            aria-hidden="true"
        >
            {children}
        </span>
    );
}
