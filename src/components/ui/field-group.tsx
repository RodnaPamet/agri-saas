"use client";

/**
 * Epic 55 — shared <FieldGroup> layout primitive.
 *
 * Stacks multiple `<FormField>`s (or plain practices) with consistent
 * vertical rhythm and an optional section header. Replaces the ad-hoc
 * `<div className="space-y-default">` / `<div className="grid grid-cols-2 gap-default">`
 * patterns that every modal/page currently rolls its own.
 *
 * Usage:
 *
 *     <FieldGroup title="Contact" description="How we'll reach you.">
 *         <FormField label="Email"><Input /></FormField>
 *         <FormField label="Phone"><Input /></FormField>
 *     </FieldGroup>
 *
 *     <FieldGroup columns={2}>
 *         <FormField label="First name"><Input /></FormField>
 *         <FormField label="Last name"><Input /></FormField>
 *     </FieldGroup>
 *
 * Accessibility:
 *   - When `title` is present, the wrapper renders with `role="group"`
 *     and `aria-labelledby` pointing at the heading so assistive tech
 *     announces "Contact group, Email edit, …" instead of flattening
 *     the hierarchy.
 */

import { cn } from "@/lib/cn";
import * as React from "react";
import { FormDescription } from "./form-description";
import { InfoTooltip } from "./tooltip";

export interface FieldGroupProps
    extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
    /** Optional section heading. Rendered as an h3 by default. */
    title?: React.ReactNode;
    /** Optional muted description below the title. */
    description?: React.ReactNode;
    /**
     * Optional contextual help surfaced via an info icon next to the
     * section heading. Use for non-obvious section semantics (e.g.,
     * "Retention — files are soft-deleted on this date").
     */
    hint?: React.ReactNode;
    /**
     * Practices the grid layout. Defaults to a single-column vertical
     * stack (the common case for CRUD modals).
     */
    columns?: 1 | 2 | 3;
    /** Vertical gap between fields. Default: `md` (1rem / gap-default). */
    gap?: "sm" | "md" | "lg";
    /** Override the heading element. Defaults to `h3`. */
    titleAs?: "h2" | "h3" | "h4";
}

const gapClass = {
    sm: "gap-tight",
    md: "gap-default",
    lg: "gap-section",
} as const;

const columnsClass = {
    1: "grid-cols-1",
    2: "grid-cols-1 sm:grid-cols-2",
    3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
} as const;

const FieldGroup = React.forwardRef<HTMLElement, FieldGroupProps>(
    (
        {
            title,
            description,
            hint,
            columns = 1,
            gap = "md",
            titleAs = "h3",
            className,
            children,
            ...props
        },
        ref,
    ) => {
        const autoId = React.useId();
        const hasTitle = Boolean(title);
        const headingId = hasTitle ? `field-group-${autoId}-title` : undefined;
        const Heading = titleAs;

        return (
            <section
                ref={ref}
                data-field-group
                role={hasTitle ? "group" : undefined}
                aria-labelledby={headingId}
                className={cn("w-full", className)}
                {...props}
            >
                {hasTitle && (
                    <header className="mb-3">
                        <div className="flex items-center gap-1.5">
                            <Heading
                                id={headingId}
                                className="text-sm font-semibold text-content-emphasis"
                            >
                                {title}
                            </Heading>
                            {hint && (
                                <InfoTooltip
                                    content={hint}
                                    aria-label={
                                        typeof title === "string"
                                            ? `More info about ${title}`
                                            : "More information"
                                    }
                                    iconClassName="h-3.5 w-3.5"
                                />
                            )}
                        </div>
                        {description && (
                            <FormDescription className="mt-0.5">
                                {description}
                            </FormDescription>
                        )}
                    </header>
                )}
                <div
                    className={cn(
                        "grid",
                        columnsClass[columns],
                        gapClass[gap],
                    )}
                >
                    {children}
                </div>
            </section>
        );
    },
);

FieldGroup.displayName = "FieldGroup";

export { FieldGroup };
