/**
 * Semantic Badge primitive (Epic 56).
 *
 * The unopinionated, composable badge used across the app — status chips,
 * category tags, counters, version pills. Token-backed and CVA-driven so
 * semantics stay consistent with the Button / StatusBadge / Tooltip layer.
 *
 * Prefer this over the legacy `className="badge badge-*"` CSS helpers
 * (`src/app/globals.css`). Reach for `<StatusBadge>` instead when the
 * badge needs a built-in icon or an explanatory tooltip — StatusBadge is
 * the higher-level composition; Badge is the raw primitive.
 *
 *   <Badge variant="success">Published</Badge>
 *   <Badge variant="error"   size="sm">Overdue</Badge>
 *   <Badge variant="info">AI-Powered</Badge>
 */

import { cn } from "@/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";

const badgeVariants = cva(
    "inline-flex max-w-fit items-center gap-1 whitespace-nowrap rounded-full font-medium",
    {
        variants: {
            variant: {
                neutral: "bg-bg-subtle text-content-muted",
                success: "bg-bg-success text-content-success",
                warning: "bg-bg-warning text-content-warning",
                error: "bg-bg-error text-content-error",
                info: "bg-bg-info text-content-info",
                attention: "bg-bg-attention text-content-attention",
                // `text-brand-default`, NOT `text-brand-muted` (#1331).
                // brand-muted on brand-subtle measures 1.76:1 in light and
                // 1.88:1 in «Слънце» — unreadable, and WCAG wants 4.5:1.
                // brand-default is the ONE brand token that clears it in all
                // three themes (4.91 / 4.60 / 4.90), so this invents no colour.
                // Latent rather than live when found: the variant had no call
                // site, so the first caller would have inherited the defect.
                brand: "bg-brand-subtle text-brand-default",
                outline:
                    "border border-border-default bg-transparent text-content-muted",
            },
            size: {
                sm: "px-1.5 py-0.5 text-[10px] leading-none",
                md: "px-2 py-0.5 text-xs leading-tight",
                lg: "px-2.5 py-1 text-[13px] leading-tight",
            },
        },
        defaultVariants: {
            variant: "neutral",
            size: "md",
        },
    },
);

export interface BadgeProps
    extends React.HTMLAttributes<HTMLSpanElement>,
        VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
    { className, variant, size, ...props },
    ref,
) {
    return (
        <span
            ref={ref}
            className={cn(badgeVariants({ variant, size }), className)}
            {...props}
        />
    );
});

export { badgeVariants };
