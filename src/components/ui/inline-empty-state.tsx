"use client";

/**
 * `<InlineEmptyState>` — small, dense empty state for tab bodies and
 * dashboard tiles (Roadmap-8 PR-1).
 *
 * Sized smaller than `<EmptyState>` (which assumes a full-card body
 * with hero icon, title, description, and primary action). Use this
 * when the empty surface is a tab body inside a detail page, a
 * dashboard tile inside a composite, or any other "one-line empty
 * inside a card" context where the full primitive is overkill.
 *
 * Three render shapes:
 *
 *   - icon + title                  — minimal surface
 *   - icon + title + description    — common
 *   - description-only              — for pure text-bodied tabs (notes)
 *
 * Composition:
 *
 *   <InlineEmptyState
 *     icon={Paperclip}
 *     title="No links yet"
 *     description="Cross-link tasks, practices, or evidence by clicking + Link."
 *   />
 *
 * Vertical rhythm — `py-8` (32px) when there's an icon; `py-6` when
 * there isn't. Locked at the primitive so consumers can't drift.
 *
 * Pairs with R7-PR6's `empty-loading-primitive-only.test.ts` ratchet —
 * existing inline `<div>No X yet</div>` divs in PENDING_MIGRATIONS
 * migrate to this primitive in R8-PR2.
 */

import { cn } from "@/lib/cn";
import { type ComponentType, type ReactNode, type SVGProps } from "react";

/**
 * Icon component shape — accepts both lucide-react icons (the
 * legacy import path being migrated away) and the canonical Nucleo
 * icon family. Both expose the same `className` + `aria-hidden`
 * surface, so the structural type is sufficient and the primitive
 * stays family-agnostic. Avoids importing lucide-react here so this
 * primitive doesn't extend the legacy-icons allowlist (R2-PR8 ratchet).
 */
type EmptyStateIcon = ComponentType<SVGProps<SVGSVGElement>>;

interface InlineEmptyStateProps {
    /**
     * Optional small icon shown above the title. When supplied,
     * vertical rhythm shifts to `py-8` to give the icon breath; the
     * iconless form uses `py-6`.
     */
    icon?: EmptyStateIcon;
    /**
     * Short title. Locked at `text-sm font-medium text-content-default`
     * — premium products lean on the icon + tone for hierarchy at
     * this density rather than weight contrast.
     */
    title?: ReactNode;
    /**
     * Optional secondary description in muted tone. Two lines max;
     * keep copy tight at this density.
     */
    description?: ReactNode;
    /** Additional className for layout escape valves. */
    className?: string;
}

export function InlineEmptyState({
    icon: Icon,
    title,
    description,
    className,
}: InlineEmptyStateProps) {
    if (!title && !description && !Icon) {
        // Defensive: at least one of the three must be set. Render
        // nothing rather than an empty padded box.
        return null;
    }

    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center text-center gap-tight",
                Icon ? "py-8" : "py-6",
                className,
            )}
            role="status"
            data-inline-empty-state
        >
            {Icon && (
                <Icon
                    className="size-5 text-content-subtle"
                    aria-hidden="true"
                />
            )}
            {title && (
                <p className="text-sm font-medium text-content-default">
                    {title}
                </p>
            )}
            {description && (
                <p className="text-xs text-content-muted max-w-md">
                    {description}
                </p>
            )}
        </div>
    );
}

export type { InlineEmptyStateProps };
